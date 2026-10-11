/**
 * Decision ④ — outcome judgment at `agent_before_settle` (docs/design.md §5).
 *
 * finish settles naturally; retry/replan inject a bounded correction and
 * continue the run. Planning validation shares the task-wide correction
 * budget with execution.
 */

import type { JevClient, JevDecideRequest, JevResponse } from "./client.ts"
import { JevError } from "./client.ts"
import type { JevConfig } from "./config.ts"
import {
	buildOutcomeEvidence,
	EvidenceTooLargeError,
	serializeEvidence,
	type EvidenceContextMessage,
} from "./evidence.ts"
import type { DecisionLogEntry } from "./log.ts"
import { outcomeActionQuestion, outcomeIssueQuestion, outcomeQualityQuestion } from "./questions.ts"

export type OutcomeAction = "finish" | "retry" | "replan"

export interface OutcomeJudged {
	action: OutcomeAction
	issue: string
	quality: number
	confidence: number
}

export interface OutcomeTaskContext {
	taskId: string
	originalPrompt: string
	phase: "direct" | "planning" | "executing" | "plan_only"
	correctionsUsed: number
	contextMessages: readonly EvidenceContextMessage[]
	approvedActions: readonly string[]
}

export interface OutcomeDeps {
	config: JevConfig
	decide: JevClient["decide"]
	/** `git diff --stat` output when enabled (via pi.exec). */
	getGitDiffStat: () => Promise<string | undefined>
	onLog: (entry: Omit<DecisionLogEntry, "timestamp">) => void
}

export type OutcomeSettleReason = "finish" | "low_confidence" | "unavailable" | "invalid_answers" | "context_too_large"

export type OutcomeVerdict =
	| { kind: "settle"; reason: OutcomeSettleReason }
	| { kind: "correct"; message: string; correctionsUsed: number }
	| { kind: "budget_exhausted"; message: string }

const ISSUE_INSTRUCTIONS: Record<string, string> = {
	none: "No unresolved issue was observed; verify the deliverable is complete and finish.",
	incomplete: "A requested requirement is missing; complete it.",
	test_failure: "Relevant verification has failed; fix the failing checks.",
	missing_verification: "Required verification has not run; run it now.",
	wrong_approach: "The approach does not solve the task; change it.",
	insufficient_context: "Evidence was insufficient to judge; verify the deliverable explicitly.",
}

/** Failed-verification summaries attached to corrections ("checks ... 如有"). */
function failedChecksSummary(evidence: ReturnType<typeof buildOutcomeEvidence>): string[] {
	return evidence.tool_evidence
		.filter((entry) => entry.status === "failed")
		.slice(-5)
		.map((entry) => `${entry.tool}: ${entry.evidence.slice(0, 120)}`)
}

export function correctionMessage(
	taskId: string,
	correctionsUsed: number,
	maxCorrections: number,
	decision: OutcomeJudged,
	checks: readonly string[] = [],
): string {
	const header = `[jev correction ${correctionsUsed}/${maxCorrections}; task ${taskId}] policy selected ${decision.action}; issue: ${decision.issue}`
	const instruction = ISSUE_INSTRUCTIONS[decision.issue] ?? ISSUE_INSTRUCTIONS["insufficient_context"]!
	const approach =
		decision.action === "replan"
			? "The current approach is fundamentally wrong: state what was wrong, outline the corrected approach, then carry it out."
			: "Address the issue with a focused correction; do not redo completed steps."
	const quality = `quality: ${decision.quality}/4`
	const checkLines = checks.length > 0 ? ["failing checks:", ...checks.map((check) => `- ${check}`)] : []
	const closing = "Finish the requested deliverable, then verify and summarize the result."
	return [header, instruction, approach, quality, ...checkLines, closing].join("\n")
}

/**
 * Judge the outcome of a completed run. Expected remote/schema/evidence
 * failures settle naturally with a structured reason and sanitized log.
 */
export async function judgeOutcome(task: OutcomeTaskContext, deps: OutcomeDeps): Promise<OutcomeVerdict> {
	const log = (
		effective: string,
		extra?: Partial<Omit<DecisionLogEntry, "timestamp" | "decisionKind" | "effective">>,
	) => {
		deps.onLog({
			decisionKind: "outcome",
			taskId: task.taskId,
			correctionPhase: task.phase === "planning" ? "planning" : "executing",
			questions: ["action", "issue", "quality"],
			effective,
			...extra,
		})
	}

	let gitDiffStat: string | undefined
	if (deps.config.outcomeGitDiff) {
		try {
			gitDiffStat = await deps.getGitDiffStat()
		} catch {
			gitDiffStat = undefined
		}
	}

	const evidence = buildOutcomeEvidence({
		originalPrompt: task.originalPrompt,
		phase: task.phase,
		contextMessages: task.contextMessages,
		gitDiffStat,
		approvedActions: task.approvedActions,
	})

	// Rule 3: refuse the decision when the (redacted, serialized) evidence is
	// too large — explicit failure instead of silent truncation.
	let state: unknown
	try {
		state = JSON.parse(serializeEvidence(evidence, [deps.config.apiKey]))
	} catch (error) {
		if (error instanceof EvidenceTooLargeError) {
			log("settle (judgment refused: decision context too large)", { error: "context_too_large" })
			return { kind: "settle", reason: "context_too_large" }
		}
		throw error
	}

	const request: JevDecideRequest = {
		state,
		questions: {
			action: outcomeActionQuestion,
			issue: outcomeIssueQuestion,
			quality: outcomeQualityQuestion,
		},
	}

	let response: JevResponse
	try {
		response = await deps.decide(request)
	} catch (error) {
		const reason = error instanceof JevError ? String(error.reason) : "transport_or_schema_error"
		log(`settle (outcome request failed: ${reason})`, { error: reason })
		return { kind: "settle", reason: "unavailable" }
	}

	const actionAnswer = response.answers["action"]
	const issueAnswer = response.answers["issue"]
	const qualityAnswer = response.answers["quality"]

	const answersSummary = {
		...(actionAnswer?.type === "choice"
			? { action: { type: "choice" as const, value: actionAnswer.choice, confidence: actionAnswer.confidence } }
			: {}),
		...(issueAnswer?.type === "choice"
			? { issue: { type: "choice" as const, value: issueAnswer.choice, confidence: issueAnswer.confidence } }
			: {}),
		...(qualityAnswer?.type === "score"
			? { quality: { type: "score" as const, value: qualityAnswer.score, confidence: qualityAnswer.confidence } }
			: {}),
	}

	if (actionAnswer?.type !== "choice" || issueAnswer?.type !== "choice" || qualityAnswer?.type !== "score") {
		log("settle (invalid answers)", { error: "invalid_answer" })
		return { kind: "settle", reason: "invalid_answers" }
	}

	const judged: OutcomeJudged = {
		action: actionAnswer.choice as OutcomeAction,
		issue: issueAnswer.choice,
		quality: qualityAnswer.score,
		confidence: actionAnswer.confidence,
	}

	// Design §5: only an explicit AND high-confidence finish may transition
	// from planning to executing — a low-confidence finish must settle too.
	const belowThreshold = judged.confidence < deps.config.outcomeConfidence
	if (judged.action === "finish" || belowThreshold) {
		const lowConfidence = judged.action !== "finish" || belowThreshold
		const why = lowConfidence
			? `confidence ${judged.confidence.toFixed(2)} < ${deps.config.outcomeConfidence}; ${task.phase === "planning" ? "rejecting plan transition" : "settling without correction"}`
			: "finish"
		log(`settle (${why})`, { answers: answersSummary, latencyMs: response.latencyMs, usage: response.usage })
		return { kind: "settle", reason: lowConfidence ? "low_confidence" : "finish" }
	}

	// retry / replan from here on.
	const remaining = deps.config.maxCorrections - task.correctionsUsed
	if (remaining <= 0) {
		const message = `[jev task ${task.taskId}] corrections budget exhausted (${task.correctionsUsed}/${deps.config.maxCorrections}); delivering current state. policy selected ${judged.action}; issue: ${judged.issue}. Review the remaining work manually.`
		log("settle (corrections budget exhausted)", { answers: answersSummary, latencyMs: response.latencyMs, usage: response.usage })
		return { kind: "budget_exhausted", message }
	}

	const checks = failedChecksSummary(evidence)
	const message = correctionMessage(task.taskId, task.correctionsUsed + 1, deps.config.maxCorrections, judged, checks)
	log(`correct (${judged.action}, correction ${task.correctionsUsed + 1}/${deps.config.maxCorrections})`, {
		answers: answersSummary,
		latencyMs: response.latencyMs,
		usage: response.usage,
	})
	return { kind: "correct", message, correctionsUsed: task.correctionsUsed + 1 }
}
