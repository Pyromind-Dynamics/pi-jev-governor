/**
 * Decisions ① + ② — plan_strategy and model tier (docs/design.md §4.1).
 *
 * One JEV request asks both questions at `before_agent_start`. Tier switching
 * guards (manual override, catalogue resolution, scopedModels, auth) follow
 * the reviewed pseudocode exactly; guards warn once and skip, never throw.
 */

import { modelsAreEqual } from "@earendil-works/pi-ai"
import type { Model } from "@earendil-works/pi-ai"
import type { ScopedModel } from "@earendil-works/pi-coding-agent"
import type { JevClient, JevDecideRequest, JevResponse, JevUsage } from "./client.ts"
import { JevError } from "./client.ts"
import type { JevConfig } from "./config.ts"
import { scrubSecretLiterals, truncateText } from "./evidence.ts"
import { planStrategyQuestion, tierQuestion, type PlanStrategy, type Tier } from "./questions.ts"

export interface RouteDecision {
	planStrategy: PlanStrategy
	/** Tier the router selected; only switched when `switchTier` is true. */
	tier: Tier
	switchTier: boolean
	planConfidence: number | undefined
	tierConfidence: number | undefined
	/** Downgrade notes for the log (empty when both answers were confident). */
	degradations: string[]
	/** Sanitized reason when the JEV request itself failed. */
	errorReason: string | undefined
	/** Request latency and token usage for the decision log; undefined when the request failed. */
	latencyMs: number | undefined
	usage: JevUsage | undefined
}

/**
 * Ask plan_strategy + tier in one request. Never throws: routing failure
 * degrades to direct + keep-current-model (routing is an optimization, not a
 * gate — fail-closed applies to permissions only).
 */
export async function decideRoute(
	decide: JevClient["decide"],
	config: JevConfig,
	prompt: string,
	fallbackTier: Tier,
): Promise<RouteDecision> {
	const request: JevDecideRequest = {
		state: { task_prompt: scrubSecretLiterals(truncateText(prompt, 2000), [config.apiKey]) },
		questions: { plan_strategy: planStrategyQuestion, tier: tierQuestion },
	}

	let response: JevResponse
	try {
		response = await decide(request)
	} catch (error) {
		const reason = error instanceof JevError ? error.reason : "transport_or_schema_error"
		return {
			planStrategy: "direct",
			tier: fallbackTier,
			switchTier: false,
			planConfidence: undefined,
			tierConfidence: undefined,
			degradations: [`route request failed (${reason}); defaulting to direct, keeping current model`],
			errorReason: String(reason),
			latencyMs: undefined,
			usage: undefined,
		}
	}

	const planAnswer = response.answers["plan_strategy"]
	const tierAnswer = response.answers["tier"]
	const degradations: string[] = []

	let planStrategy: PlanStrategy
	let planConfidence: number | undefined
	if (planAnswer?.type === "choice" && planAnswer.confidence >= config.routeConfidence) {
		planStrategy = planAnswer.choice as PlanStrategy
		planConfidence = planAnswer.confidence
	} else if (planAnswer?.type === "choice") {
		planStrategy = "direct"
		planConfidence = planAnswer.confidence
		degradations.push(`plan_strategy confidence ${planAnswer.confidence.toFixed(2)} < ${config.routeConfidence}; defaulting to direct`)
	} else {
		planStrategy = "direct"
		degradations.push("plan_strategy answer missing; defaulting to direct")
	}

	let tier: Tier = fallbackTier
	let switchTier = false
	let tierConfidence: number | undefined
	if (tierAnswer?.type === "choice" && tierAnswer.confidence >= config.routeConfidence) {
		tier = tierAnswer.choice as Tier
		switchTier = true
		tierConfidence = tierAnswer.confidence
	} else if (tierAnswer?.type === "choice") {
		tierConfidence = tierAnswer.confidence
		degradations.push(`tier confidence ${tierAnswer.confidence.toFixed(2)} < ${config.routeConfidence}; keeping current model`)
	} else {
		degradations.push("tier answer missing; keeping current model")
	}

	return { planStrategy, tier, switchTier, planConfidence, tierConfidence, degradations, errorReason: undefined, latencyMs: response.latencyMs, usage: response.usage }
}

export type ModelRef = `${string}:${string}`

export function toModelRef(model: { provider: string; id: string }): ModelRef {
	return `${model.provider}:${model.id}`
}

export interface TierSwitchInput {
	/** Configured target, `provider:modelId`. */
	targetRef: string
	/** `${provider}:${id}` of the currently selected model, if any. */
	currentRef: string | undefined
	/** Model the router set last (may be from a previous task in this session). */
	lastSetModelId: string | undefined
	available: readonly Model<any>[]
	scopedModels: readonly ScopedModel[]
	/** Estimated tokens in the current transcript, when pi can provide it. */
	contextTokens?: number
	/** Whether the current prompt or transcript contains image input. */
	requiresImage?: boolean
	setModel: (model: Model<any>) => Promise<boolean>
	/** Deduplicated warning callback; the extension makes it warn-once. */
	warn: (key: string, message: string) => void
}

export interface TierSwitchResult {
	/** True when the target model is (already) the routing choice for this task. */
	switched: boolean
	/** New `${provider}:${id}` to remember when `switched` is true. */
	modelRef: ModelRef | undefined
	skippedReason: string | undefined
}

/**
 * Switch the session model to the routed tier with all guards from the design:
 * manual-override detection, catalogue resolution, scopedModels membership,
 * and provider auth. Guards skip with a warning; they never throw.
 */
export async function applyTierSwitch(input: TierSwitchInput): Promise<TierSwitchResult> {
	const colon = input.targetRef.indexOf(":")
	if (colon <= 0 || colon === input.targetRef.length - 1) {
		input.warn("tier-parse", "jev: tier model reference is not in provider:modelId form; skipping model switch")
		return { switched: false, modelRef: undefined, skippedReason: "invalid_target_ref" }
	}
	const provider = input.targetRef.slice(0, colon)
	const modelId = input.targetRef.slice(colon + 1)

	// The user changed the model since our last routing decision: they keep
	// control; this task skips tier switching entirely.
	if (input.lastSetModelId !== undefined && input.currentRef !== undefined && input.currentRef !== input.lastSetModelId) {
		return { switched: false, modelRef: undefined, skippedReason: "manual_override" }
	}

	const model = input.available.find((m) => m.provider === provider && m.id === modelId)
	if (model === undefined) {
		input.warn(
			`tier-resolve:${input.targetRef}`,
			`jev: tier model cannot be resolved from the available catalogue; skipping model switch`,
		)
		return { switched: false, modelRef: undefined, skippedReason: "unresolved_model" }
	}

	// Respect --models scoping: an out-of-scope model is never forced.
	if (input.scopedModels.length > 0 && !input.scopedModels.some((sm) => modelsAreEqual(sm.model, model))) {
		input.warn(
			`tier-scoped:${input.targetRef}`,
			"jev: tier model is not within scopedModels; skipping model switch",
		)
		return { switched: false, modelRef: undefined, skippedReason: "not_scoped" }
	}
	if (input.contextTokens !== undefined && input.contextTokens > model.contextWindow) {
		input.warn(
			`tier-context:${input.targetRef}`,
			"jev: current context exceeds the tier model context window; keeping current model",
		)
		return { switched: false, modelRef: undefined, skippedReason: "context_too_large" }
	}
	if (input.requiresImage === true && !model.input.includes("image")) {
		input.warn(
			`tier-image:${input.targetRef}`,
			"jev: current context contains images but the tier model is text-only; keeping current model",
		)
		return { switched: false, modelRef: undefined, skippedReason: "image_not_supported" }
	}

	const targetRef = toModelRef(model)
	if (input.currentRef === targetRef) {
		// Already on the routed model; remember it for override detection.
		return { switched: true, modelRef: targetRef, skippedReason: undefined }
	}

	const ok = await input.setModel(model)
	if (!ok) {
		// setModel returns false only when provider auth is not configured.
		input.warn(`tier-auth:${targetRef}`, "jev: provider authentication is not configured for the tier model; keeping current model")
		return { switched: false, modelRef: undefined, skippedReason: "auth_not_configured" }
	}
	return { switched: true, modelRef: targetRef, skippedReason: undefined }
}

/** Built-in tools that survive the read-only plan phase (bash gated by isSafeCommand at tool_call). */
export const PLAN_PHASE_TOOLS: ReadonlySet<string> = new Set(["read", "bash", "grep", "find", "ls", "questionnaire"])

/** Custom/MCP tools are dropped; edit/write dropped; bash kept for read-only allowlist use. */
export function planPhaseTools(activeTools: readonly string[]): string[] {
	return activeTools.filter((name) => PLAN_PHASE_TOOLS.has(name))
}

export function planInstruction(strategy: "plan_only" | "plan_then_execute"): string {
	if (strategy === "plan_only") {
		return `[JEV PLAN-ONLY PHASE - READ-ONLY]
The requested deliverable for this task is a plan, analysis, or review - not an implementation.
Restrictions:
- edit and write tools are disabled
- bash is restricted to an allowlist of read-only commands
- custom tools are disabled
Deliver the complete requested plan or analysis. Do NOT implement any changes.`
	}
	return `[JEV PLAN PHASE - READ-ONLY]
This task was routed through a read-only planning phase before execution.
Restrictions:
- edit and write tools are disabled
- bash is restricted to an allowlist of read-only commands
- custom tools are disabled
First produce a concise, numbered implementation plan under a "Plan:" header: files to touch, ordered steps, risks, and how each step will be verified.
Do NOT make any changes in this phase. When the plan is delivered, execution continues automatically in this session.`
}

export function executionInstruction(): string {
	return `[JEV EXECUTION PHASE]
The read-only planning phase is complete and the full tool set is restored.
Execute the plan above now, in this session:
- follow the numbered plan in order
- verify each step the way the plan promised
- when finished, summarize what was done and how it was verified`
}
