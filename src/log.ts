/**
 * JSONL decision log (docs/design.md §11).
 *
 * One line per decision appended to a session-specific JSONL file. Best-effort:
 * callers swallow errors so logging can never break the agent loop.
 */

import { appendFile, chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { JevUsage } from "./client.ts"

export type DecisionKind = "route" | "permission" | "outcome"

export interface DecisionAnswerSummary {
	type: "choice" | "score"
	value: string | number
	confidence: number
}

export interface DecisionLogEntry {
	/** ISO timestamp. */
	timestamp: string
	decisionKind: DecisionKind
	taskId: string
	correctionPhase?: "planning" | "executing"
	/** Question ids that were asked. */
	questions?: string[]
	answers?: Record<string, DecisionAnswerSummary>
	latencyMs?: number
	usage?: JevUsage
	/** Final action that took effect, including any downgrade reason. */
	effective: string
	/** Sanitized failure reason (enum only) when the decision errored. */
	error?: string
}

export function decisionLogFilename(sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "session"
	return `decisions-${safe}.jsonl`
}

export async function appendDecisionLog(logDir: string, sessionId: string, entry: DecisionLogEntry): Promise<void> {
	await mkdir(logDir, { recursive: true, mode: 0o700 })
	await chmod(logDir, 0o700)
	const path = join(logDir, decisionLogFilename(sessionId))
	await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 })
	await chmod(path, 0o600)
}
