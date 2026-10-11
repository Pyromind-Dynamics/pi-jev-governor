import { describe, expect, it, vi } from "vitest"
import type { JevDecideRequest, JevResponse } from "../src/client.ts"
import { JevError } from "../src/client.ts"
import type { JevConfig } from "../src/config.ts"
import {
	applyTierSwitch,
	decideRoute,
	executionInstruction,
	planInstruction,
	planPhaseTools,
	toModelRef,
} from "../src/route.ts"
import { planStrategyQuestion, tierQuestion } from "../src/questions.ts"

const CONFIG: JevConfig = {
	url: "https://decisions.example.com",
	apiKey: "sk-secret-0123456789",
	model: "typesafe/jev-1.13",
	timeoutMs: 3000,
	models: {
		small: "acme:small-model",
		normal: "acme:normal-model",
		strong: "acme:strong-model",
	},
	routeConfidence: 0.8,
	permissionConfidence: 0.9,
	outcomeConfidence: 0.8,
	maxCorrections: 2,
	outcomeGitDiff: true,
	planAutoExecute: true,
	logDir: "/tmp/.pi-jev",
}

function routeResponse(plan: string, planConf: number, tier: string, tierConf: number): JevResponse {
	return {
		answers: {
			plan_strategy: {
				type: "choice",
				choice: plan,
				confidence: planConf,
				probabilities: { direct: 0, plan_only: 0, plan_then_execute: 1 },
			},
			tier: { type: "choice", choice: tier, confidence: tierConf, probabilities: { small: 0, normal: 0, strong: 1 } },
		},
		model: "typesafe/jev-1.13",
		usage: { cost: 0.00001, input_tokens: 100, output_tokens: 20 },
		latencyMs: 12,
	}
}

describe("decideRoute", () => {
	it("asks both questions in one request", async () => {
		const decide = vi.fn(async (request: JevDecideRequest) => {
			expect(Object.keys(request.questions)).toEqual(["plan_strategy", "tier"])
			expect(request.questions["plan_strategy"]).toBe(planStrategyQuestion)
			expect(request.questions["tier"]).toBe(tierQuestion)
			return routeResponse("plan_then_execute", 0.95, "strong", 0.9)
		})
		const decision = await decideRoute(decide, CONFIG, "refactor the auth module", "normal")
		expect(decision).toMatchObject({ planStrategy: "plan_then_execute", tier: "strong", switchTier: true })
		expect(decision.degradations).toEqual([])
		expect(decision.latencyMs).toBe(12)
		expect(decision.usage).toEqual({ cost: 0.00001, input_tokens: 100, output_tokens: 20 })
	})

	it("degrades to direct when plan confidence is below the threshold", async () => {
		const decision = await decideRoute(
			vi.fn(async () => routeResponse("plan_then_execute", 0.6, "strong", 0.9)),
			CONFIG,
			"task",
			"normal",
		)
		expect(decision.planStrategy).toBe("direct")
		expect(decision.degradations.join(" ")).toContain("confidence")
	})

	it("keeps the current model when tier confidence is below the threshold", async () => {
		const decision = await decideRoute(
			vi.fn(async () => routeResponse("direct", 0.95, "strong", 0.5)),
			CONFIG,
			"task",
			"small",
		)
		expect(decision.switchTier).toBe(false)
		expect(decision.tier).toBe("small")
	})

	it("degrades fully (direct, keep model) when the request throws", async () => {
		const decision = await decideRoute(
			vi.fn(async () => {
				throw new JevError("http_500")
			}),
			CONFIG,
			"task",
			"normal",
		)
		expect(decision.planStrategy).toBe("direct")
		expect(decision.switchTier).toBe(false)
		expect(decision.errorReason).toBe("http_500")
		expect(decision.latencyMs).toBeUndefined()
		expect(decision.usage).toBeUndefined()
	})
})

interface FakeModel {
	provider: string
	id: string
}

type TierSwitchArgs = Parameters<typeof applyTierSwitch>[0]

function tierSwitchInput(overrides: Partial<TierSwitchArgs> = {}): TierSwitchArgs & { setModel: ReturnType<typeof vi.fn> } {
	const setModel = vi.fn(async (_model: unknown) => true)
	const base = {
		targetRef: "acme:strong-model",
		currentRef: "acme:normal-model",
		lastSetModelId: "acme:normal-model" as string | undefined,
		available: [
			{ provider: "acme", id: "normal-model" },
			{ provider: "acme", id: "strong-model" },
		] as unknown as TierSwitchArgs["available"],
		scopedModels: [] as unknown as TierSwitchArgs["scopedModels"],
		warn: vi.fn(),
	}
	return { setModel, ...base, ...overrides } as TierSwitchArgs & { setModel: ReturnType<typeof vi.fn> }
}

describe("applyTierSwitch", () => {
	it("switches to the resolved model and reports the new ref", async () => {
		const input = tierSwitchInput()
		const result = await applyTierSwitch(input)
		expect(result.switched).toBe(true)
		expect(result.modelRef).toBe("acme:strong-model")
		expect(input.setModel).toHaveBeenCalledTimes(1)
		const model = input.setModel.mock.calls[0]![0] as FakeModel
		expect(model.provider).toBe("acme")
		expect(model.id).toBe("strong-model")
	})

	it("skips when the user manually changed the model since the last routing", async () => {
		const input = tierSwitchInput({ currentRef: "acme:normal-model", lastSetModelId: "acme:strong-model" })
		const result = await applyTierSwitch(input)
		expect(result.switched).toBe(false)
		expect(result.skippedReason).toBe("manual_override")
		expect(input.setModel).not.toHaveBeenCalled()
	})

	it("does not treat a missing lastSetModelId as an override (first task)", async () => {
		const input = tierSwitchInput({ lastSetModelId: undefined })
		const result = await applyTierSwitch(input)
		expect(result.switched).toBe(true)
	})

	it("skips with one warning when the model is not in the catalogue", async () => {
		const input = tierSwitchInput({ targetRef: "acme:mystery-model" })
		const result = await applyTierSwitch(input)
		expect(result.skippedReason).toBe("unresolved_model")
		expect(input.warn).toHaveBeenCalledTimes(1)
		expect(input.setModel).not.toHaveBeenCalled()
	})

	it("skips when the model is outside scopedModels", async () => {
		const input = tierSwitchInput({
			scopedModels: [{ model: { provider: "acme", id: "normal-model" } }] as unknown as Parameters<typeof applyTierSwitch>[0]["scopedModels"],
		})
		const result = await applyTierSwitch(input)
		expect(result.skippedReason).toBe("not_scoped")
		expect(input.setModel).not.toHaveBeenCalled()
	})

	it("allows the switch when the model is within scopedModels", async () => {
		const input = tierSwitchInput({
			scopedModels: [{ model: { provider: "acme", id: "strong-model" } }] as unknown as Parameters<typeof applyTierSwitch>[0]["scopedModels"],
		})
		const result = await applyTierSwitch(input)
		expect(result.switched).toBe(true)
	})

	it("keeps the current model when setModel reports missing auth", async () => {
		const input = tierSwitchInput({ setModel: vi.fn(async () => false) })
		const result = await applyTierSwitch(input)
		expect(result.skippedReason).toBe("auth_not_configured")
		expect(input.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("authentication"))
	})

	it("no-ops but remembers the ref when already on the target model", async () => {
		const input = tierSwitchInput({ currentRef: "acme:strong-model", lastSetModelId: "acme:normal-model" })
		// currentRef equals lastSetModelId is required to pass the override check;
		// with a manual change to exactly the target we still respect the user.
		const overridden = await applyTierSwitch(input)
		expect(overridden.skippedReason).toBe("manual_override")

		const aligned = tierSwitchInput({ currentRef: "acme:strong-model", lastSetModelId: "acme:strong-model" })
		const result = await applyTierSwitch(aligned)
		expect(result.switched).toBe(true)
		expect(result.modelRef).toBe("acme:strong-model")
		expect(aligned.setModel).not.toHaveBeenCalled()
	})

	it("rejects malformed target refs", async () => {
		const input = tierSwitchInput({ targetRef: "no-colon" })
		const result = await applyTierSwitch(input)
		expect(result.skippedReason).toBe("invalid_target_ref")
	})

	it("keeps the current model when the routed model context window is too small", async () => {
		const input = tierSwitchInput({
			contextTokens: 50_000,
			available: [
				{ provider: "acme", id: "strong-model", contextWindow: 32_000, input: ["text"] },
			] as unknown as TierSwitchArgs["available"],
		})
		const result = await applyTierSwitch(input)
		expect(result.skippedReason).toBe("context_too_large")
		expect(input.setModel).not.toHaveBeenCalled()
	})

	it("keeps an image-capable model when the routed model is text-only", async () => {
		const input = tierSwitchInput({
			requiresImage: true,
			available: [
				{ provider: "acme", id: "strong-model", contextWindow: 128_000, input: ["text"] },
			] as unknown as TierSwitchArgs["available"],
		})
		const result = await applyTierSwitch(input)
		expect(result.skippedReason).toBe("image_not_supported")
		expect(input.setModel).not.toHaveBeenCalled()
	})
})

describe("plan phase tools and instructions", () => {
	it("keeps read-only builtins (incl. bash), drops edit/write and custom tools", () => {
		expect(
			planPhaseTools(["read", "edit", "write", "bash", "grep", "find", "ls", "mcp_server_tool", "custom-thing"]),
		).toEqual(["read", "bash", "grep", "find", "ls"])
	})

	it("plan instructions state the read-only restrictions", () => {
		expect(planInstruction("plan_only")).toContain("Do NOT implement")
		expect(planInstruction("plan_then_execute")).toContain("numbered implementation plan")
		expect(executionInstruction()).toContain("full tool set is restored")
	})

	it("toModelRef joins provider and id", () => {
		expect(toModelRef({ provider: "openrouter", id: "google/gemini-2.5-pro" })).toBe(
			"openrouter:google/gemini-2.5-pro",
		)
	})
})
