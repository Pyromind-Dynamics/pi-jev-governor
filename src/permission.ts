/**
 * Decision ③ — permission adjudication at `tool_call` (docs/design.md §6).
 *
 * Three layers:
 *  0. phase gate — read-only phases allow only read-only tools / safe bash;
 *  1. deterministic rules — hard-deny patterns, builtin read tools, and the
 *     task-approved list (no JEV call);
 *  2. JEV adjudication — allow / deny, with human confirmation for ask,
 *     low confidence, or JEV failure. Fail closed when no UI is available.
 *
 * This is workflow control, not a security sandbox: the extension runs in the
 * same process with the same privileges as pi itself.
 */

import type { JevClient, JevDecideRequest, JevResponse } from "./client.ts"
import { JevError } from "./client.ts"
import {
	redactSensitiveKeys,
	scrubSecretLiterals,
	SENSITIVE_TOOL_PATTERN,
	stableStringify,
	truncateText,
} from "./evidence.ts"
import type { DecisionLogEntry } from "./log.ts"
import { permissionQuestion } from "./questions.ts"
import type { JevPhase } from "./state.ts"

export interface PermissionCall {
	toolName: string
	input: Record<string, unknown>
}

export interface PermissionTaskContext {
	taskId: string
	phase: JevPhase
	originalPrompt: string
	/** Summaries of operations approved in this task (evidence for layer 2). */
	approvedActions: readonly string[]
}

export type HumanChoice = "allow_once" | "allow_exact_for_task" | "allow_tool_for_task" | "block"

export interface PermissionDeps {
	permissionConfidence: number
	secretLiterals: readonly string[]
	decide?: JevClient["decide"]
	hasUI: boolean
	ask: (title: string, message: string, allowCache: boolean) => Promise<HumanChoice | undefined>
	/** Task-scoped approvals; shared with the extension that owns the sets. */
	taskApprovedExact: ReadonlySet<string>
	taskApprovedTools: ReadonlySet<string>
	onLog: (entry: Omit<DecisionLogEntry, "timestamp">) => void
}

export interface PermissionVerdict {
	/** undefined result = allow (return nothing from the hook). */
	block: boolean
	reason?: string
	terminate?: boolean
	source: string
}

const ALLOW = (source: string): PermissionVerdict => ({ block: false, source })
const BLOCK = (source: string, reason: string, terminate = false): PermissionVerdict => ({
	block: true,
	reason,
	terminate,
	source,
})

/** Layer 1 hard-deny patterns for bash commands (from pi's permission-gate example). */
export const HARD_DENY_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-rf?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
]

/** Layer 1 always-allow builtin read tools (plus the interactive questionnaire, which only asks the user). */
export const BUILTIN_READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "questionnaire"])

/** Tools allowed during read-only phases (layer 0), bash gated by isSafeCommand. */
const PHASE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"questionnaire",
	"pwd",
])

// Read-only bash allowlist, migrated from pi's plan-mode example (utils.ts).
const SAFE_PATTERNS: readonly RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	// No env/printenv: dumping KEY=value environment text would flow into JEV
	// evidence as plain strings that key redaction cannot catch.
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
]

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
]

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command))
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command))
	return !isDestructive && isSafe
}

/** Key identifying "same tool with same normalized input" for task approval. */
export function approvalKey(call: PermissionCall): string {
	return `${call.toolName}:${stableStringify(redactSensitiveKeys(call.input))}`
}

const SENSITIVE_COMMAND_PATTERNS: readonly RegExp[] = [
	/\b(?:authorization|proxy-authorization)\s*:/i,
	/\bbearer\s+[A-Za-z0-9._~+\/-]{8,}/i,
	/\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*=\s*\S+/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
]

export function sensitivePermissionInput(call: PermissionCall, secrets: readonly string[]): boolean {
	const serialized = stableStringify(redactSensitiveKeys(call.input))
	if (SENSITIVE_TOOL_PATTERN.test(serialized)) return true
	const command = bashCommandOf(call.input)
	if (command === undefined) return false
	if (SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return true
	return secrets.some((secret) => secret.length >= 8 && command.includes(secret))
}

export function sanitizedPermissionInput(call: PermissionCall, secrets: readonly string[]): string {
	let serialized = scrubSecretLiterals(stableStringify(redactSensitiveKeys(call.input)), secrets)
	serialized = serialized.replace(
		/(\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer\s+)?)[^"'\s]+/gi,
		"$1[redacted]",
	)
	serialized = serialized.replace(/(\bbearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]")
	serialized = serialized.replace(
		/(\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*=\s*)[^&\s"']+/gi,
		"$1[redacted]",
	)
	return serialized
}

export function bashCommandOf(input: Record<string, unknown>): string | undefined {
	const command = input["command"]
	return typeof command === "string" ? command : undefined
}

export function isHardDenied(command: string): boolean {
	return HARD_DENY_PATTERNS.some((p) => p.test(command))
}

/**
 * Adjudicate one tool call. Returns the verdict; callers map
 * `block: false` to an undefined hook result.
 */
export async function adjudicate(
	call: PermissionCall,
	task: PermissionTaskContext,
	deps: PermissionDeps,
): Promise<PermissionVerdict> {
	const log = (effective: string, extra?: Partial<Omit<DecisionLogEntry, "timestamp" | "decisionKind" | "effective">>) => {
		deps.onLog({
			decisionKind: "permission",
			taskId: task.taskId,
			questions: ["action"],
			effective,
			...extra,
		})
	}

	// Layer 0 — phase gate. During read-only phases this layer is complete:
	// tools cannot write, and bash is restricted to the read-only allowlist.
	if (task.phase === "planning" || task.phase === "plan_only") {
		if (PHASE_READ_ONLY_TOOLS.has(call.toolName)) {
			log("allow (read-only phase, builtin read tool)")
			return ALLOW("phase_gate")
		}
		if (call.toolName === "bash" || call.toolName === "powershell") {
			const command = bashCommandOf(call.input)
			if (command !== undefined && isSafeCommand(command)) {
				log("allow (read-only phase, allowlisted command)")
				return ALLOW("phase_gate")
			}
			const verdict = BLOCK(
				"phase_gate",
				`JEV: plan phase is read-only; command is not on the read-only allowlist: ${truncateText(command ?? "", 200)}`,
			)
			log(`block (${verdict.source})`)
			return verdict
		}
		const verdict = BLOCK("phase_gate", `JEV: plan phase is read-only; tool '${call.toolName}' is disabled`)
		log(`block (${verdict.source})`)
		return verdict
	}

	// Layer 1 — deterministic rules.
	if (call.toolName === "bash" || call.toolName === "powershell") {
		const command = bashCommandOf(call.input)
		if (command !== undefined && isHardDenied(command)) {
			const verdict = BLOCK(
				"hard_deny",
				`JEV: command matches a hard-deny pattern and will not execute: ${truncateText(command, 200)}`,
			)
			log(`block (hard_deny)`)
			return verdict
		}
	}
	if (BUILTIN_READ_TOOLS.has(call.toolName)) {
		log("allow (builtin read tool)")
		return ALLOW("builtin_allow")
	}
	if (deps.taskApprovedTools.has(call.toolName) || deps.taskApprovedExact.has(approvalKey(call))) {
		log("allow (approved for this task)")
		return ALLOW("task_approved")
	}

	const secretLiterals = deps.secretLiterals
	const sensitive = sensitivePermissionInput(call, secretLiterals)
	const sanitizedInput = sanitizedPermissionInput(call, secretLiterals)

	// Layer 2 — JEV adjudication. Every outgoing task prompt is scrubbed, the
	// same invariant as the route and outcome paths.
	const request: JevDecideRequest = {
		state: {
			task_prompt: scrubSecretLiterals(truncateText(task.originalPrompt, 2000), deps.secretLiterals),
			tool_name: call.toolName,
			tool_input: truncateText(sanitizedInput, 4000),
			approved_operations: task.approvedActions.map((a) => truncateText(a, 200)),
		},
		questions: { action: permissionQuestion },
	}

	let response: JevResponse | undefined
	let errorReason: string | undefined
	if (sensitive) {
		errorReason = "sensitive_input_local_only"
	} else if (deps.decide === undefined) {
		errorReason = "jev_unavailable"
	} else {
		try {
			response = await deps.decide(request)
		} catch (error) {
			errorReason = error instanceof JevError ? String(error.reason) : "transport_or_schema_error"
		}
	}

	if (response !== undefined) {
		const answer = response.answers["action"]
		if (answer?.type === "choice") {
			if (answer.choice === "allow" && answer.confidence >= deps.permissionConfidence) {
				log("allow (jev)", {
					answers: { action: { type: "choice", value: answer.choice, confidence: answer.confidence } },
					latencyMs: response.latencyMs,
					usage: response.usage,
				})
				return ALLOW("jev_allow")
			}
			if (answer.choice === "deny") {
				const verdict = BLOCK(
					"jev_deny",
					`JEV: call denied (confidence ${answer.confidence.toFixed(2)}): operation is clearly prohibited or malicious`,
					true,
				)
				log(`block (jev_deny, confidence ${answer.confidence.toFixed(2)})`, {
					answers: { action: { type: "choice", value: answer.choice, confidence: answer.confidence } },
					latencyMs: response.latencyMs,
					usage: response.usage,
				})
				return verdict
			}
			// "ask" or low confidence falls through to the human gate.
		}
	}

	// Ask / low confidence / JEV failure: human decides; fail closed without UI.
	if (!deps.hasUI) {
		const effective = `block (fail_closed${errorReason !== undefined ? `, ${errorReason}` : ""})`
		const verdict = BLOCK(
			"fail_closed",
			`JEV: needs confirmation and no UI is available; blocked (fail closed)${errorReason !== undefined ? ` [${errorReason}]` : ""}`,
		)
		log(effective, errorReason !== undefined ? { error: errorReason } : undefined)
		return verdict
	}

	const title = "JEV permission gate"
	const message = [
		`Tool: ${call.toolName}`,
		`Arguments: ${truncateText(sanitizedInput, 500)}`,
		`Task: ${truncateText(task.originalPrompt, 300)}`,
		errorReason !== undefined
			? errorReason === "sensitive_input_local_only"
				? "Sensitive input was kept local; manual confirmation is required."
				: `JEV adjudication unavailable (${errorReason}); manual confirmation required.`
			: "JEV requested confirmation for this call.",
	].join("\n")
	const choice = await deps.ask(title, message, !sensitive)

	if (choice !== undefined && choice !== "block") {
		const effectiveChoice = sensitive ? "allow_once" : choice
		log(`allow (human, ${effectiveChoice})`)
		return { block: false, source: `human_${effectiveChoice}` }
	}
	const verdict = BLOCK("human_block", "Blocked by user")
	log("block (human)")
	return verdict
}
