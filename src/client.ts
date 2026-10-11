/**
 * JEV Decisions API client.
 *
 * Native fetch + hand-written type guards, with zero runtime dependencies.
 * Contract and validation rules are preserved verbatim (docs/design.md §10).
 *
 * Error hygiene: every thrown error carries ONLY a reason enum — never the
 * response body, the URL, or provider error text (any of which may contain
 * secrets).
 */

import type { JevQuestion } from "./questions.ts"

export interface JevChoiceAnswer {
	type: "choice"
	choice: string
	confidence: number
	probabilities: Record<string, number>
}

export interface JevScoreAnswer {
	type: "score"
	score: number
	confidence: number
	probabilities: Record<string, number>
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer

export interface JevUsage {
	cost?: number
	input_tokens?: number
	output_tokens?: number
}

export interface JevResponse {
	answers: Record<string, JevAnswer>
	model: string | undefined
	usage: JevUsage | undefined
	latencyMs: number
}

export type JevErrorReason =
	| "invalid_answer"
	| "invalid_choice"
	| "invalid_score"
	| "invalid_distribution"
	| "transport_or_schema_error"
	| `http_${number}`

export class JevError extends Error {
	readonly reason: JevErrorReason

	constructor(reason: JevErrorReason) {
		// The message is the reason enum only — by design it must never embed
		// response bodies, URLs, or provider error text.
		super(reason)
		this.name = "JevError"
		this.reason = reason
	}
}

/** Sum of probabilities may deviate from 1 by at most this much. */
export const PROBABILITY_SUM_TOLERANCE = 0.02

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 524, 529])

export interface JevClientOptions {
	url: string
	apiKey: string
	model: string
	timeoutMs: number
	/** Injectable for tests. */
	fetchImpl?: typeof fetch
}

export interface JevDecideRequest {
	/** Evidence object; must already be redacted by the caller. */
	state: unknown
	questions: Record<string, JevQuestion>
}

export interface JevClient {
	decide(request: JevDecideRequest, signal?: AbortSignal): Promise<JevResponse>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateConfidence(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
		throw new JevError("invalid_answer")
	}
	return raw
}

function validateProbabilities(raw: unknown, expectedKeys: readonly string[]): Record<string, number> {
	if (!isRecord(raw)) throw new JevError("invalid_distribution")
	const actualKeys = Object.keys(raw)
	const expected = [...expectedKeys]
	if (actualKeys.length !== expected.length || !expected.every((key) => key in raw)) {
		throw new JevError("invalid_distribution")
	}
	let sum = 0
	for (const key of expected) {
		const p = raw[key]
		if (typeof p !== "number" || !Number.isFinite(p) || p < 0) throw new JevError("invalid_distribution")
		sum += p
	}
	if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) throw new JevError("invalid_distribution")
	return raw as Record<string, number>
}

function validateAnswer(question: JevQuestion, raw: unknown): JevAnswer {
	if (!isRecord(raw)) throw new JevError("invalid_answer")
	const confidence = validateConfidence(raw["confidence"])

	if (question.type === "choice") {
		if (raw["type"] !== "choice") throw new JevError("invalid_answer")
		const choice = raw["choice"]
		if (typeof choice !== "string" || !(choice in question.criteria)) throw new JevError("invalid_choice")
		const probabilities = validateProbabilities(raw["probabilities"], Object.keys(question.criteria))
		return { type: "choice", choice, confidence, probabilities }
	}

	if (raw["type"] !== "score") throw new JevError("invalid_answer")
	const score = raw["score"]
	// The Decisions API returns the probability-weighted expectation over the
	// levels, not an integer index — e.g. score 3.9 with P(3)=0.06, P(4)=0.93.
	if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score >= question.criteria.length) {
		throw new JevError("invalid_score")
	}
	const probabilities = validateProbabilities(raw["probabilities"], question.criteria.map((_, i) => String(i)))
	return { type: "score", score, confidence, probabilities }
}

/**
 * Validate a raw response body against the questions that were asked.
 * Throws {@link JevError} with the first violated rule; never leaks body text.
 */
export function validateJevResponse(
	questions: Record<string, JevQuestion>,
	raw: unknown,
): { answers: Record<string, JevAnswer>; model: string | undefined; usage: JevUsage | undefined } {
	if (!isRecord(raw)) throw new JevError("transport_or_schema_error")
	const answersRaw = raw["answers"]
	if (!isRecord(answersRaw)) throw new JevError("transport_or_schema_error")

	const model = raw["model"]
	if (model !== undefined && typeof model !== "string") throw new JevError("transport_or_schema_error")

	let usage: JevUsage | undefined
	const usageRaw = raw["usage"]
	if (usageRaw !== undefined) {
		if (!isRecord(usageRaw)) throw new JevError("transport_or_schema_error")
		usage = {}
		for (const key of ["cost", "input_tokens", "output_tokens"] as const) {
			const value = usageRaw[key]
			if (value !== undefined) {
				if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
					throw new JevError("transport_or_schema_error")
				}
				usage[key] = value
			}
		}
	}

	const answers: Record<string, JevAnswer> = {}
	for (const [id, question] of Object.entries(questions)) {
		const answerRaw = answersRaw[id]
		// Every question must have a matching answer; the answer type must match.
		answers[id] = validateAnswer(question, answerRaw)
	}
	return { answers, model, usage }
}

export function createJevClient(options: JevClientOptions): JevClient {
	const doFetch = options.fetchImpl ?? fetch
	return {
		async decide(request: JevDecideRequest, externalSignal?: AbortSignal): Promise<JevResponse> {
			const body = JSON.stringify({
				model: options.model,
				state: request.state,
				questions: request.questions,
			})
			const headers = {
				"content-type": "application/json",
				authorization: `Bearer ${options.apiKey}`,
			}

			const startedAt = Date.now()
			// One timeout signal covers the whole decide() call, including the
			// single retry: permission adjudication blocks the agent loop, so the
			// worst-case wait must be timeoutMs, not 2 × timeoutMs.
			const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
			const signal = externalSignal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, externalSignal])
			let lastStatus = 0
			for (let attempt = 0; attempt < 2; attempt++) {
				let response: Response
				try {
					response = await doFetch(options.url, {
						method: "POST",
						headers,
						body,
						signal,
						// The endpoint is a fixed API address; a redirect is
						// unexpected and would leak the bearer header elsewhere.
						redirect: "error",
					})
				} catch {
					// Retry one transient transport failure within the shared deadline.
					// Timeouts and explicit aborts never retry.
					if (attempt === 0 && !signal.aborted) continue
					throw new JevError("transport_or_schema_error")
				}

				if (response.ok) {
					let json: unknown
					try {
						json = await response.json()
					} catch {
						throw new JevError("transport_or_schema_error")
					}
					const validated = validateJevResponse(request.questions, json)
					return { ...validated, latencyMs: Date.now() - startedAt }
				}

				lastStatus = response.status
				if (attempt === 0 && RETRYABLE_STATUSES.has(response.status)) {
					continue
				}
				throw new JevError(`http_${response.status}`)
			}
			throw new JevError(`http_${lastStatus}`)
		},
	}
}
