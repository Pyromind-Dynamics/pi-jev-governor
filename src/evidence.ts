/**
 * Evidence construction and redaction (docs/design.md §8).
 *
 * Three redaction rules protect decision evidence:
 *  1. Sensitive tool evidence is omitted entirely.
 *  2. Sensitive keys are redacted during serialization; configured API-key
 *     literals are scrubbed from the final text.
 *  3. Serialized evidence larger than 96000 chars aborts the decision — an
 *     explicit failure, never a silent truncation.
 */

/** Structural view of an AgentMessage from the settle boundary context. */
export interface EvidenceContextMessage {
	role: string
	content?: unknown
	toolName?: string
	toolCallId?: string
	isError?: boolean
}

export const SENSITIVE_TOOL_PATTERN = /(?:\.env\b|credentials|\.pem\b|\.key\b|id_rsa)/i
export const SENSITIVE_KEY_PATTERN = /api.?key|authorization|password|secret|access.?token/i
export const SENSITIVE_TOOL_OMITTED = "Sensitive tool evidence omitted"
/**
 * Content-level credential contexts for the evidence second layer: tool
 * OUTPUT containing these is omitted wholesale. Narrow by design (same
 * philosophy as permission sensitive-command detection) — no context-free
 * high-entropy rules, so git SHAs, hash constants and base64 stay safe.
 */
export const SENSITIVE_CONTENT_PATTERN =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:authorization|proxy-authorization)\s*:/i
export const MAX_CONTEXT_CHARS = 96_000
export const TEXT_TRUNCATE_CHARS = 2_000
export const TOOL_JSON_TRUNCATE_CHARS = 4_000
export const MAX_TOOL_EVIDENCE = 10
const TRUNCATION_MARKER = "…[truncated]"

export class EvidenceTooLargeError extends Error {
	constructor() {
		super("Decision context too large")
		this.name = "EvidenceTooLargeError"
	}
}

export function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	return text.slice(0, maxChars) + TRUNCATION_MARKER
}

/** Rule 2a: recursively replace values of sensitive keys with [redacted]. */
export function redactSensitiveKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactSensitiveKeys)
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value)) {
			out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redactSensitiveKeys(child)
		}
		return out
	}
	return value
}

/** Rule 2b: scrub configured secret literals from the serialized text. */
export function scrubSecretLiterals(text: string, secrets: readonly string[]): string {
	let out = text
	for (const secret of secrets) {
		if (secret && secret.length >= 8) {
			out = out.replaceAll(secret, "[redacted]")
		}
	}
	return out
}

/** Stable JSON with sorted keys, so identical inputs serialize identically. */
export function stableStringify(value: unknown): string {
	const seen = new Set<unknown>()
	const serialize = (input: unknown): string => {
		if (input === null || typeof input !== "object") return JSON.stringify(input) ?? "null"
		if (seen.has(input)) return '"[circular]"'
		seen.add(input)
		try {
			if (Array.isArray(input)) return `[${input.map(serialize).join(",")}]`
			const keys = Object.keys(input).sort()
			return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize((input as Record<string, unknown>)[key])}`).join(",")}}`
		} finally {
			seen.delete(input)
		}
	}
	return serialize(value)
}

export interface ToolEvidenceEntry {
	tool: string
	status: "ok" | "failed"
	evidence: string
}

function textPartsOf(content: unknown): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "object" && part !== null && "text" in part) {
					return String((part as { text: unknown }).text)
				}
				return ""
			})
			.filter((text) => text !== "")
			.join("\n")
	}
	return ""
}

/**
 * Collect tool-call arguments by toolCallId from assistant toolCall parts.
 * The settle context pairs assistant toolCall blocks with toolResult messages
 * via this id, so arguments can be attributed to their results.
 */
function collectToolArguments(messages: readonly EvidenceContextMessage[]): Map<string, { tool: string; argsJson: string }> {
	const argsById = new Map<string, { tool: string; argsJson: string }>()
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const part of message.content) {
			if (typeof part !== "object" || part === null) continue
			const block = part as { type?: string; id?: string; name?: string; arguments?: unknown }
			if (block.type !== "toolCall" || typeof block.id !== "string") continue
			const argsJson =
				typeof block.arguments === "string"
					? block.arguments
					: stableStringify(redactSensitiveKeys(block.arguments ?? {}))
			argsById.set(block.id, { tool: typeof block.name === "string" ? block.name : "unknown", argsJson })
		}
	}
	return argsById
}

/**
 * Build the tail tool evidence: last {@link MAX_TOOL_EVIDENCE} toolResult
 * messages, each truncated to {@link TOOL_JSON_TRUNCATE_CHARS} chars.
 *
 * Rule 1: the sensitive-file regex applies to the
 * tool's ARGUMENTS (e.g. a read of `.env`) — a matching entry is replaced
 * wholesale. Output text is checked as a second layer.
 */
export function buildToolEvidence(messages: readonly EvidenceContextMessage[]): ToolEvidenceEntry[] {
	const argsById = collectToolArguments(messages)
	const toolMessages = messages.filter((message) => message.role === "toolResult")
	const tail = toolMessages.slice(-MAX_TOOL_EVIDENCE)
	return tail.map((message) => {
		const tool = message.toolName ?? "unknown"
		const call = message.toolCallId !== undefined ? argsById.get(message.toolCallId) : undefined
		// Rule 1 primary check: tool arguments (key-redacted before matching so
		// only path/name semantics decide sensitivity).
		const argsSensitive = call !== undefined && SENSITIVE_TOOL_PATTERN.test(call.argsJson)
		const payload = {
			tool,
			...(call !== undefined ? { arguments: truncateText(call.argsJson, TOOL_JSON_TRUNCATE_CHARS) } : {}),
			input_text: truncateText(textPartsOf(message.content), TOOL_JSON_TRUNCATE_CHARS),
			failed: message.isError === true,
		}
		const serialized = truncateText(stableStringify(redactSensitiveKeys(payload)), TOOL_JSON_TRUNCATE_CHARS)
		// Second layer: output text that itself looks sensitive — either a
		// sensitive path/name or an embedded credential context (a benign read
		// of an innocently-named file can still surface a bearer token).
		const evidence =
			argsSensitive || SENSITIVE_TOOL_PATTERN.test(serialized) || SENSITIVE_CONTENT_PATTERN.test(serialized)
				? SENSITIVE_TOOL_OMITTED
				: serialized
		return { tool, status: message.isError === true ? "failed" : "ok", evidence }
	})
}

export interface OutcomeEvidenceInput {
	originalPrompt: string
	phase: "direct" | "planning" | "executing" | "plan_only"
	contextMessages: readonly EvidenceContextMessage[]
	/** Output of `git diff --stat` when enabled, already trimmed. */
	gitDiffStat?: string
	/** Short summaries of operations approved this task. */
	approvedActions?: readonly string[]
}

export interface OutcomeEvidence {
	task_prompt: string
	phase: "direct" | "planning" | "executing" | "plan_only"
	tool_evidence: ToolEvidenceEntry[]
	approved_operations?: string[]
	git_diff_stat?: string
}

export function buildOutcomeEvidence(input: OutcomeEvidenceInput): OutcomeEvidence {
	const evidence: OutcomeEvidence = {
		task_prompt: truncateText(input.originalPrompt, TEXT_TRUNCATE_CHARS),
		phase: input.phase,
		tool_evidence: buildToolEvidence(input.contextMessages),
	}
	if (input.approvedActions !== undefined && input.approvedActions.length > 0) {
		evidence.approved_operations = input.approvedActions.map((action) => truncateText(action, 200))
	}
	if (input.gitDiffStat !== undefined && input.gitDiffStat !== "") {
		evidence.git_diff_stat = truncateText(input.gitDiffStat, TOOL_JSON_TRUNCATE_CHARS)
	}
	return evidence
}

/**
 * Serialize evidence for a JEV request. Applies rule 2 (key redaction is the
 * caller's responsibility for structured parts; here secrets are scrubbed)
 * and rule 3 (size cap throws {@link EvidenceTooLargeError}).
 */
export function serializeEvidence(evidence: unknown, secretLiterals: readonly string[]): string {
	const serialized = scrubSecretLiterals(stableStringify(evidence), secretLiterals)
	if (serialized.length > MAX_CONTEXT_CHARS) {
		throw new EvidenceTooLargeError()
	}
	return serialized
}
