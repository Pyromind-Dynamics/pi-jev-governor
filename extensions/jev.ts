/**
 * pi-jev extension entry. The host integration stays here; decision logic
 * lives in ../src so it remains independently testable.
 */

import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	CustomEntryDraft,
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent"
import { createJevClient, type JevClient } from "../src/client.ts"
import { isJevEnvEnabled, loadConfig, type ConfigResult, type JevConfig } from "../src/config.ts"
import { stableStringify, truncateText, type EvidenceContextMessage } from "../src/evidence.ts"
import { appendDecisionLog, decisionLogFilename, type DecisionLogEntry } from "../src/log.ts"
import {
	adjudicate,
	approvalKey,
	sanitizedPermissionInput,
	type HumanChoice,
	type PermissionCall,
} from "../src/permission.ts"
import { judgeOutcome, type OutcomeSettleReason, type OutcomeVerdict } from "../src/outcome.ts"
import {
	applyTierSwitch,
	decideRoute,
	executionInstruction,
	planInstruction,
	planPhaseTools,
} from "../src/route.ts"
import {
	createTaskState,
	JEV_STATE_CUSTOM_TYPE,
	restoreState,
	toExecutingPhase,
	toPlanPhase,
	type JevState,
} from "../src/state.ts"
import type { Tier } from "../src/questions.ts"

export default function jevExtension(pi: ExtensionAPI): void {
	pi.registerFlag("no-jev", {
		description: "Disable JEV decisions for this session",
		type: "boolean",
		default: false,
	})

	let envResult: ConfigResult | undefined
	let configNoticeShown = false
	/** undefined follows flag/env; explicit values are controlled by /jev. */
	let runtimeSwitch: boolean | undefined
	let task: JevState | undefined
	let lastSetModelId: string | undefined
	let client: JevClient | undefined
	let decisionCount = 0
	let sessionId = "session"
	let permissionTail: Promise<void> = Promise.resolve()
	const taskApprovedExact = new Set<string>()
	const taskApprovedTools = new Set<string>()
	const approvedSummaries: string[] = []
	const warnedOnce = new Set<string>()

	const loadEnvResult = (): ConfigResult => {
		if (envResult === undefined) {
			envResult = loadConfig({ env: process.env, flagEnabled: true, cwd: process.cwd() })
		}
		return envResult
	}

	const explicitlyDisabled = (): boolean =>
		runtimeSwitch === false || pi.getFlag("no-jev") === true || !isJevEnvEnabled(process.env)

	const getConfig = (): JevConfig | undefined => {
		if (explicitlyDisabled()) return undefined
		return loadEnvResult().config
	}

	const getClient = (): JevClient => {
		if (client === undefined) {
			const config = getConfig()
			if (config === undefined) throw new Error("jev: client requested while remote decisions are unavailable")
			client = createJevClient({
				url: config.url,
				apiKey: config.apiKey,
				model: config.model,
				timeoutMs: config.timeoutMs,
			})
		}
		return client
	}

	const log = (entry: Omit<DecisionLogEntry, "timestamp">): void => {
		decisionCount++
		const config = loadEnvResult().config
		if (config === undefined) return
		void appendDecisionLog(config.logDir, sessionId, { ...entry, timestamp: new Date().toISOString() }).catch(() => {
			// Logging is best-effort and must never break the agent loop.
		})
	}

	const stateEntry = (state: JevState | null): CustomEntryDraft => ({
		type: "custom",
		customType: JEV_STATE_CUSTOM_TYPE,
		data: state,
	})

	const correctionEntry = (content: string): CustomMessageEntryDraft => ({
		type: "custom_message",
		customType: "jev-correction",
		content,
		display: true,
	})

	const clearTaskApprovals = (): void => {
		taskApprovedExact.clear()
		taskApprovedTools.clear()
		approvedSummaries.length = 0
	}

	const warnOnce = (key: string, message: string, ctx: ExtensionContext): void => {
		if (warnedOnce.has(key)) return
		warnedOnce.add(key)
		ctx.ui.notify(message, "warning")
	}

	const updateStatus = (ctx: ExtensionContext): void => {
		if (explicitlyDisabled()) {
			ctx.ui.setStatus("jev", runtimeSwitch === false ? "jev:off" : undefined)
			return
		}
		const result = loadEnvResult()
		if (result.config === undefined) {
			ctx.ui.setStatus("jev", "jev:degraded")
			return
		}
		if (task === undefined) {
			ctx.ui.setStatus("jev", "jev:ready")
			return
		}
		const suffix = task.correctionsUsed > 0 ? ` ·${task.correctionsUsed}/${result.config.maxCorrections}` : ""
		ctx.ui.setStatus("jev", `jev:${task.phase}/${task.tier}${suffix}`)
	}

	const restoreTools = (state: JevState | undefined): void => {
		if (state?.toolsBeforePlan !== undefined) pi.setActiveTools(state.toolsBeforePlan)
	}

	const restoreFromActiveBranch = (ctx: ExtensionContext): void => {
		const previous = task
		const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>
		const entry = [...branch]
			.reverse()
			.find((candidate) => candidate.type === "custom" && candidate.customType === JEV_STATE_CUSTOM_TYPE)
		const restored = restoreState(entry?.data)
		if (restored === undefined) {
			restoreTools(previous)
			task = undefined
			lastSetModelId = undefined
		} else {
			task = restored
			lastSetModelId = restored.lastSetModelId
			if (restored.phase === "planning" || restored.phase === "plan_only") {
				pi.setActiveTools(planPhaseTools(restored.toolsBeforePlan ?? pi.getActiveTools()))
			} else {
				restoreTools(restored)
			}
		}
		clearTaskApprovals()
		updateStatus(ctx)
	}

	const branchContainsImage = (event: BeforeAgentStartEvent, ctx: ExtensionContext): boolean => {
		if (event.images !== undefined && event.images.length > 0) return true
		const projection = ctx.sessionManager.buildSessionProjection()
		return projection.messages.some((message) => {
			if (!("content" in message) || !Array.isArray(message.content)) return false
			return message.content.some(
				(part: unknown) => typeof part === "object" && part !== null && "type" in part && part.type === "image",
			)
		})
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId()
		const result = loadEnvResult()
		if (!explicitlyDisabled() && result.config === undefined && result.unavailableReason !== undefined && !configNoticeShown) {
			configNoticeShown = true
			ctx.ui.notify(`${result.unavailableReason}; routing/outcome use safe defaults and permissions remain enforced`, "warning")
		}
		restoreFromActiveBranch(ctx)
	})

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromActiveBranch(ctx)
	})

	pi.on("before_agent_start", async (event, ctx) => {
		if (explicitlyDisabled()) return undefined
		clearTaskApprovals()
		const config = getConfig()
		if (config === undefined) {
			const currentRef = ctx.model === undefined ? undefined : `${ctx.model.provider}:${ctx.model.id}`
			task = createTaskState(event.prompt, "normal", currentRef)
			lastSetModelId = currentRef
			pi.appendEntry(JEV_STATE_CUSTOM_TYPE, task)
			updateStatus(ctx)
			return undefined
		}

		const currentTier: Tier = task?.tier ?? "normal"
		const route = await decideRoute((request) => getClient().decide(request, ctx.signal), config, event.prompt, currentTier)
		let modelRef: string | undefined = lastSetModelId
		let tierSkipReason: string | undefined
		if (route.switchTier) {
			const currentRef = ctx.model === undefined ? undefined : `${ctx.model.provider}:${ctx.model.id}`
			const usage = ctx.getContextUsage()
			const switchResult = await applyTierSwitch({
				targetRef: config.models[route.tier],
				currentRef,
				lastSetModelId,
				available: ctx.modelRegistry.getAvailable(),
				scopedModels: ctx.scopedModels,
				...(usage?.tokens !== null && usage?.tokens !== undefined ? { contextTokens: usage.tokens } : {}),
				requiresImage: branchContainsImage(event, ctx),
				setModel: (model) => pi.setModel(model),
				warn: (key, message) => warnOnce(key, message, ctx),
			})
			if (switchResult.modelRef !== undefined) modelRef = switchResult.modelRef
			tierSkipReason = switchResult.skippedReason
		}
		lastSetModelId = modelRef

		const state = createTaskState(event.prompt, route.tier, modelRef)
		if (route.planStrategy === "plan_only" || route.planStrategy === "plan_then_execute") {
			const before = pi.getActiveTools()
			task = toPlanPhase(state, route.planStrategy, before)
			pi.setActiveTools(planPhaseTools(before))
		} else {
			task = state
		}
		pi.appendEntry(JEV_STATE_CUSTOM_TYPE, task)

		log({
			decisionKind: "route",
			taskId: state.taskId,
			questions: ["plan_strategy", "tier"],
			answers: {
				...(route.planConfidence !== undefined
					? { plan_strategy: { type: "choice" as const, value: route.planStrategy, confidence: route.planConfidence } }
					: {}),
				...(route.tierConfidence !== undefined
					? { tier: { type: "choice" as const, value: route.tier, confidence: route.tierConfidence } }
					: {}),
			},
			...(route.latencyMs !== undefined ? { latencyMs: route.latencyMs } : {}),
			...(route.usage !== undefined ? { usage: route.usage } : {}),
			effective: [
				`phase=${task.phase}`,
				route.switchTier
					? tierSkipReason === undefined
						? `tier=${route.tier}`
						: `tier=${route.tier} (skipped: ${tierSkipReason})`
					: "tier=kept",
				...route.degradations,
			].join("; "),
			...(route.errorReason !== undefined ? { error: route.errorReason } : {}),
		})
		updateStatus(ctx)

		if (task.phase !== "planning" && task.phase !== "plan_only") return undefined
		const strategy = route.planStrategy === "plan_only" ? "plan_only" : "plan_then_execute"
		const result: BeforeAgentStartEventResult = {
			message: { customType: "jev-plan-context", content: planInstruction(strategy), display: false },
		}
		return result
	})

	const runPermissionUnchecked = async (
		call: PermissionCall,
		current: JevState,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> => {
		const config = getConfig()
		const verdict = await adjudicate(
			call,
			{
				taskId: current.taskId,
				phase: current.phase,
				originalPrompt: current.originalPrompt,
				approvedActions: [...approvedSummaries],
			},
			{
				permissionConfidence: config?.permissionConfidence ?? 0.9,
				secretLiterals: config === undefined ? [] : [config.apiKey],
				...(config === undefined ? {} : { decide: (request) => getClient().decide(request, ctx.signal) }),
				hasUI: ctx.hasUI,
				ask: async (title, message, allowCache) => {
					const options = allowCache
						? ["Allow once", "Allow this exact call for this task", "Allow this tool for this task", "Block"]
						: ["Allow once", "Block"]
					const choice = await ctx.ui.select(`${title}\n\n${message}`, options)
					if (choice === "Allow once") return "allow_once"
					if (choice === "Allow this exact call for this task") return "allow_exact_for_task"
					if (choice === "Allow this tool for this task") return "allow_tool_for_task"
					return "block"
				},
				taskApprovedExact,
				taskApprovedTools,
				onLog: log,
			},
		)

		if (verdict.source === "human_allow_exact_for_task") taskApprovedExact.add(approvalKey(call))
		if (verdict.source === "human_allow_tool_for_task") taskApprovedTools.add(call.toolName)
		if (["jev_allow", "human_allow_once", "human_allow_exact_for_task", "human_allow_tool_for_task"].includes(verdict.source)) {
			const secrets = config === undefined ? [] : [config.apiKey]
			approvedSummaries.push(`${call.toolName} ${truncateText(sanitizedPermissionInput(call, secrets), 120)}`)
		}

		if (!verdict.block) return undefined
		const result: ToolCallEventResult = { block: true, reason: verdict.reason }
		if (verdict.terminate) result.terminate = true
		return result
	}

	const runPermission = async (
		call: PermissionCall,
		current: JevState,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> => {
		try {
			return await runPermissionUnchecked(call, current, ctx)
		} catch {
			const aborted = ctx.signal?.aborted === true
			const error = aborted ? "permission_aborted" : "permission_handler_error"
			log({
				decisionKind: "permission",
				taskId: current.taskId,
				questions: ["action"],
				effective: `block (fail_closed, ${error})`,
				error,
			})
			return {
				block: true,
				reason: aborted
					? "JEV: permission adjudication was aborted; blocked (fail closed)"
					: "JEV: permission adjudication failed unexpectedly; blocked (fail closed)",
			}
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		if (explicitlyDisabled() || task === undefined) return undefined
		const current = task
		const call: PermissionCall = { toolName: event.toolName, input: event.input as Record<string, unknown> }
		const pending = permissionTail.then(() => runPermission(call, current, ctx))
		permissionTail = pending.then(
			() => undefined,
			() => undefined,
		)
		return pending
	})

	const judge = (
		current: JevState,
		event: AgentBeforeSettleEvent,
		ctx: ExtensionContext,
		config: JevConfig,
	): Promise<OutcomeVerdict> =>
		judgeOutcome(
			{
				taskId: current.taskId,
				originalPrompt: current.originalPrompt,
				phase: current.phase,
				correctionsUsed: current.correctionsUsed,
				contextMessages: event.context.contextMessages as unknown as readonly EvidenceContextMessage[],
				approvedActions: [...approvedSummaries],
			},
			{
				config,
				decide: (request) => getClient().decide(request, ctx.signal),
				getGitDiffStat: async () => {
					const result = await pi.exec("git", ["diff", "--stat"], { cwd: ctx.cwd })
					return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined
				},
				onLog: log,
			},
		)

	const finishAtBoundary = (ctx: ExtensionContext): AgentBeforeSettleEventResult => {
		task = undefined
		clearTaskApprovals()
		updateStatus(ctx)
		return { entries: [stateEntry(null)] }
	}

	const planValidationFailureMessage = (taskId: string, reason: Exclude<OutcomeSettleReason, "finish">): string => {
		const explanation: Record<Exclude<OutcomeSettleReason, "finish">, string> = {
			low_confidence: "plan validation confidence was below the required threshold",
			unavailable: "the plan validation service was unavailable",
			invalid_answers: "the plan validation response was incomplete or invalid",
			context_too_large: "the redacted plan evidence exceeded the safe decision-context limit",
		}
		return `[jev task ${taskId}] ${explanation[reason]}; execution was not started.`
	}

	const planningSettle = async (
		event: AgentBeforeSettleEvent,
		ctx: ExtensionContext,
		config: JevConfig,
	): Promise<AgentBeforeSettleEventResult> => {
		const current = task
		if (current === undefined) return { entries: [] }
		const verdict = await judge(current, event, ctx, config)

		if (verdict.kind === "correct") {
			const next = { ...current, correctionsUsed: verdict.correctionsUsed }
			task = next
			updateStatus(ctx)
			return { entries: [stateEntry(next), correctionEntry(verdict.message)], continue: true }
		}

		if (verdict.kind === "budget_exhausted") {
			restoreTools(current)
			task = undefined
			clearTaskApprovals()
			updateStatus(ctx)
			return { entries: [stateEntry(null), correctionEntry(verdict.message)] }
		}

		if (verdict.reason !== "finish") {
			restoreTools(current)
			task = undefined
			clearTaskApprovals()
			updateStatus(ctx)
			return {
				entries: [
					stateEntry(null),
					correctionEntry(planValidationFailureMessage(current.taskId, verdict.reason)),
				],
			}
		}

		let execute = config.planAutoExecute
		if (!execute && ctx.hasUI) {
			execute = await ctx.ui.confirm(
				"JEV plan accepted",
				"The read-only plan passed outcome validation. Execute it now with the full tool set?",
			)
		}
		restoreTools(current)
		if (!execute) return finishAtBoundary(ctx)

		const next = toExecutingPhase(current)
		task = next
		updateStatus(ctx)
		return {
			entries: [
				stateEntry(next),
				{
					type: "custom_message",
					customType: "jev-execution-context",
					content: executionInstruction(),
					display: false,
				},
			],
			continue: true,
		}
	}

	const outcomeSettle = async (
		event: AgentBeforeSettleEvent,
		ctx: ExtensionContext,
		config: JevConfig,
	): Promise<AgentBeforeSettleEventResult> => {
		const current = task
		if (current === undefined) return { entries: [] }
		const verdict = await judge(current, event, ctx, config)
		if (verdict.kind === "settle") return finishAtBoundary(ctx)
		if (verdict.kind === "budget_exhausted") {
			const finished = finishAtBoundary(ctx)
			return { entries: [...(finished.entries ?? []), correctionEntry(verdict.message)] }
		}
		const next = { ...current, correctionsUsed: verdict.correctionsUsed }
		task = next
		updateStatus(ctx)
		return { entries: [stateEntry(next), correctionEntry(verdict.message)], continue: true }
	}

	pi.on("agent_before_settle", async (event, ctx) => {
		if (explicitlyDisabled() || task === undefined) return undefined
		const current = task
		const config = getConfig()
		if (event.outcome !== "completed" || config === undefined) {
			restoreTools(current)
			return finishAtBoundary(ctx)
		}
		if (current.phase === "planning") return planningSettle(event, ctx, config)
		return outcomeSettle(event, ctx, config)
	})

	pi.registerCommand("jev", {
		description: "JEV decision routing: show status, /jev on, /jev off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase()
			if (arg === "off") {
				runtimeSwitch = false
				restoreTools(task)
				task = undefined
				clearTaskApprovals()
				pi.appendEntry(JEV_STATE_CUSTOM_TYPE, null)
				ctx.ui.notify("jev: disabled for this session", "info")
				updateStatus(ctx)
				return
			}
			if (arg === "on") {
				runtimeSwitch = true
				const config = getConfig()
				ctx.ui.notify(
					config === undefined
						? `${loadEnvResult().unavailableReason ?? "jev: remote decisions unavailable"}; degraded mode`
						: "jev: enabled",
					config === undefined ? "warning" : "info",
				)
				updateStatus(ctx)
				return
			}
			if (arg !== "") {
				ctx.ui.notify("usage: /jev [on|off]", "info")
				return
			}
			const config = getConfig()
			ctx.ui.notify(
				[
					`status: ${explicitlyDisabled() ? "off" : config === undefined ? "degraded" : "on"}`,
					`phase: ${task?.phase ?? "—"}`,
					`tier: ${task?.tier ?? "—"}`,
					`corrections: ${task?.correctionsUsed ?? 0}/${config?.maxCorrections ?? 2}`,
					`decisions this session: ${decisionCount}`,
					...(config === undefined
						? [`remote: ${loadEnvResult().unavailableReason ?? "unavailable"}`]
						: [
							`log: ${config.logDir}/${decisionLogFilename(sessionId)}`,
							`models: small=${config.models.small} normal=${config.models.normal} strong=${config.models.strong}`,
						]),
				].join("\n"),
				"info",
			)
		},
	})
}
