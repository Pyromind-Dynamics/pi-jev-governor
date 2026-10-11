/**
 * Configuration: environment variables + the `no-jev` CLI flag.
 *
 * Validation is split in two (docs/design.md §12):
 * - load time: strings and numbers only. Invalid config => degraded mode with
 *   a single UI notice; permissions remain fail-closed.
 * - first route: tier model resolvability (see src/route.ts) — the model
 *   catalogue is not complete while extensions load.
 */

import { homedir } from "node:os"
import { join } from "node:path"

export interface JevModels {
	small: string
	normal: string
	strong: string
}

export interface JevConfig {
	url: string
	apiKey: string
	model: string
	timeoutMs: number
	models: JevModels
	routeConfidence: number
	permissionConfidence: number
	outcomeConfidence: number
	/** Hard-capped at MAX_CORRECTIONS_HARD_CAP. */
	maxCorrections: number
	outcomeGitDiff: boolean
	planAutoExecute: boolean
	logDir: string
}

export interface ConfigResult {
	/** Present only when configuration is valid and enabled. */
	config: JevConfig | undefined
	/** Human-readable reason remote decisions are unavailable. */
	unavailableReason: string | undefined
}

export interface LoadConfigOptions {
	env: Record<string, string | undefined>
	/** False when the registered `no-jev` flag explicitly disables the plugin. */
	flagEnabled: boolean
	cwd: string
	platform?: NodeJS.Platform
	homeDir?: string
}

export const DEFAULT_JEV_URL = "https://openrouter.ai/api/alpha/decisions"
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13"
export const DEFAULT_TIMEOUT_MS = 3000
export const MIN_TIMEOUT_MS = 1
export const MAX_TIMEOUT_MS = 60000
export const MAX_CORRECTIONS_HARD_CAP = 2

function unavailable(reason: string): ConfigResult {
	return { config: undefined, unavailableReason: reason }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback
	const normalized = value.trim().toLowerCase()
	if (["1", "true", "yes", "on"].includes(normalized)) return true
	if (["0", "false", "no", "off"].includes(normalized)) return false
	return fallback
}

export function isJevEnvEnabled(env: Record<string, string | undefined>): boolean {
	return parseBoolean(env["PI_JEV_ENABLED"], true)
}

export function defaultLogDir(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform = process.platform,
	homeDir: string = homedir(),
): string {
	const explicit = env["PI_JEV_LOG_DIR"]?.trim()
	if (explicit) return explicit
	const xdg = env["XDG_STATE_HOME"]?.trim()
	if (xdg) return join(xdg, "pi-jev")
	if (platform === "darwin") return join(homeDir, "Library", "Application Support", "pi-jev")
	if (platform === "win32") {
		const localAppData = env["LOCALAPPDATA"]?.trim()
		if (localAppData) return join(localAppData, "pi-jev")
	}
	return join(homeDir, ".local", "state", "pi-jev")
}

/** undefined = unset, NaN = set but not a finite number. */
function parseNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * Parse a `provider:modelId` reference, splitting on the FIRST colon — model
 * IDs may themselves contain `/` or `:` (e.g. openrouter `google/gemini-2.5-pro`).
 */
export function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const colon = ref.indexOf(":")
	// Also require no whitespace; refs come from environment variables.
	if (colon <= 0 || colon === ref.length - 1 || /\s/.test(ref)) return undefined
	return { provider: ref.slice(0, colon), modelId: ref.slice(colon + 1) }
}

function loadModels(env: Record<string, string | undefined>): JevModels | undefined {
	const entries: [keyof JevModels, string | undefined][] = [
		["small", env["PI_JEV_MODEL_SMALL"]],
		["normal", env["PI_JEV_MODEL_NORMAL"]],
		["strong", env["PI_JEV_MODEL_STRONG"]],
	]
	const models = {} as JevModels
	for (const [tier, value] of entries) {
		if (value === undefined || value.trim() === "") {
			return undefined
		}
		const ref = value.trim()
		if (parseModelRef(ref) === undefined) return undefined
		models[tier] = ref
	}
	return models
}

export function loadConfig(options: LoadConfigOptions): ConfigResult {
	const { env, flagEnabled } = options

	if (!flagEnabled) return unavailable("jev: disabled by --no-jev flag")
	if (!isJevEnvEnabled(env)) return unavailable("jev: disabled by PI_JEV_ENABLED")

	const apiKey = env["PI_JEV_API_KEY"]?.trim()
	if (apiKey === undefined || apiKey === "") {
		return unavailable("jev: PI_JEV_API_KEY is not set; remote decisions are unavailable")
	}

	const url = env["PI_JEV_URL"]?.trim() || DEFAULT_JEV_URL
	let parsedUrl: URL
	try {
		parsedUrl = new URL(url)
	} catch {
		return unavailable(`jev: PI_JEV_URL is not a valid URL; remote decisions are unavailable`)
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		return unavailable("jev: PI_JEV_URL must be http(s); remote decisions are unavailable")
	}

	const timeoutRaw = parseNumber(env["PI_JEV_TIMEOUT_MS"]) ?? DEFAULT_TIMEOUT_MS
	if (Number.isNaN(timeoutRaw) || !Number.isInteger(timeoutRaw) || timeoutRaw < MIN_TIMEOUT_MS || timeoutRaw > MAX_TIMEOUT_MS) {
		return unavailable(`jev: PI_JEV_TIMEOUT_MS must be an integer in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`)
	}

	const models = loadModels(env)
	if (models === undefined) {
		return unavailable(
			"jev: PI_JEV_MODEL_SMALL/NORMAL/STRONG must all be set in provider:modelId form (model IDs may contain '/')",
		)
	}

	const routeConfidence = parseNumber(env["PI_JEV_ROUTE_CONFIDENCE"]) ?? 0.8
	if (Number.isNaN(routeConfidence) || routeConfidence < 0 || routeConfidence > 1) {
		return unavailable("jev: PI_JEV_ROUTE_CONFIDENCE must be within [0, 1]")
	}
	const permissionConfidence = parseNumber(env["PI_JEV_PERMISSION_CONFIDENCE"]) ?? 0.9
	if (Number.isNaN(permissionConfidence) || permissionConfidence < 0 || permissionConfidence > 1) {
		return unavailable("jev: PI_JEV_PERMISSION_CONFIDENCE must be within [0, 1]")
	}
	const outcomeConfidence = parseNumber(env["PI_JEV_OUTCOME_CONFIDENCE"]) ?? 0.8
	if (Number.isNaN(outcomeConfidence) || outcomeConfidence < 0 || outcomeConfidence > 1) {
		return unavailable("jev: PI_JEV_OUTCOME_CONFIDENCE must be within [0, 1]")
	}

	const correctionsRaw = parseNumber(env["PI_JEV_MAX_CORRECTIONS"]) ?? MAX_CORRECTIONS_HARD_CAP
	if (Number.isNaN(correctionsRaw) || !Number.isInteger(correctionsRaw) || correctionsRaw < 0) {
		return unavailable("jev: PI_JEV_MAX_CORRECTIONS must be an integer >= 0")
	}
	// Hard cap: never allow more than 2 automatic corrections per task.
	const maxCorrections = Math.min(correctionsRaw, MAX_CORRECTIONS_HARD_CAP)

	return {
		config: {
			url,
			apiKey,
			model: env["PI_JEV_MODEL"]?.trim() || DEFAULT_JEV_MODEL,
			timeoutMs: timeoutRaw,
			models,
			routeConfidence,
			permissionConfidence,
			outcomeConfidence,
			maxCorrections,
			outcomeGitDiff: parseBoolean(env["PI_JEV_OUTCOME_GIT_DIFF"], false),
			planAutoExecute: parseBoolean(env["PI_JEV_PLAN_AUTO_EXECUTE"], true),
			logDir: defaultLogDir(env, options.platform, options.homeDir),
		},
		unavailableReason: undefined,
	}
}
