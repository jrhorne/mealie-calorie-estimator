import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import {
  estimateGrams,
  estimateNutrients,
  verifyNutritionCandidates,
} from "../src/services/llm-estimator.js"
import { initCache, clearLlmCache } from "../src/utils/cache.js"
import { config } from "../src/config.js"

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.structuredOutputs = true
  config.llm.maxRetries = 0
  config.llm.retryBackoffMs = 1
  clearLlmCache()
  vi.restoreAllMocks()
})

describe("estimateGrams", () => {
  it("returns null when LLM is disabled", async () => {
    const result = await estimateGrams(2, "Dose", "Tomaten")
    expect(result).toBeNull()
  })

  it("returns null when API key is not set", async () => {
    config.llm.enabled = true
    const result = await estimateGrams(1, "Glas", "Honig")
    expect(result).toBeNull()
  })

  it("returns grams from API and multiplies by quantity", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"
    config.llm.reasoningEffort = "minimal"
    config.llm.reasoningExclude = true

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "google/gemma-3-4b-it",
        choices: [{ finish_reason: "stop", message: { content: "{\"grams\":400}" } }],
        usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 },
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateGrams(2, "Dose", "Tomaten")
    expect(result).toBe(800)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callArgs = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callArgs.messages[0].content).toContain("Dose")
    expect(callArgs.messages[0].content).toContain("Tomaten")
    expect(callArgs.response_format.type).toBe("json_schema")
    expect(callArgs.max_tokens).toBe(64)
  })

  it("returns cached value without calling API", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"grams\":250}" } }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    await estimateGrams(1, "Glas", "Gurken")
    const result = await estimateGrams(3, "Glas", "Gurken")
    expect(result).toBe(750)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("returns null on API error", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateGrams(1, "Päckchen", "Hefe")
    expect(result).toBeNull()
  })

  it("returns null on invalid response (non-numeric)", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"grams\":\"unknown\"}" } }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateGrams(1, "Bund", "Petersilie")
    expect(result).toBeNull()
  })

  it("returns null on zero response", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "{\"grams\":0}" } }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateGrams(1, "Stange", "Lauch")
    expect(result).toBeNull()
  })

  it("accepts text content arrays from OpenAI-compatible providers", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: [{ type: "text", text: "{\"grams\":120}" }] } }],
      }),
    }))

    await expect(estimateGrams(3, "item", "pepper")).resolves.toBe(360)
  })

  it("returns null when a successful response has no final content", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: "length", message: { content: null, reasoning: "..." } }],
      }),
    }))

    await expect(estimateGrams(1, "box", "pasta")).resolves.toBeNull()
  })
})

describe("estimateNutrients", () => {
  it("requests schema-enforced nutrients and parses milligram fields", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "google/gemma-3-4b-it",
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              kcal: 20,
              protein: 1,
              carbs: 4,
              fat: 0.2,
              saturatedFat: 0,
              transFat: 0,
              fiber: 1.5,
              sugar: 2.5,
              sodium: 300,
              cholesterol: 0,
            }),
          },
        }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateNutrients("diced tomatoes")

    expect(result?.kcalPer100g).toBe(20)
    expect(result?.sodiumPer100g).toBe(300)
    const callArgs = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callArgs.response_format.json_schema.name).toBe("nutrient_estimate")
    expect(callArgs.max_tokens).toBe(256)
  })

  it("preserves sodium for zero-calorie foods", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              kcal: 0,
              protein: 0,
              carbs: 0,
              fat: 0,
              saturatedFat: 0,
              transFat: 0,
              fiber: 0,
              sugar: 0,
              sodium: 38758,
              cholesterol: 0,
            }),
          },
        }],
      }),
    }))

    const result = await estimateNutrients("salt")

    expect(result).not.toBeNull()
    expect(result?.kcalPer100g).toBeNull()
    expect(result?.sodiumPer100g).toBe(38758)
  })
})

describe("verifyNutritionCandidates", () => {
  it("fails closed on a near-match when LLM verification is unavailable", async () => {
    config.llm.enabled = false

    const decisions = await verifyNutritionCandidates([{
      ingredient: "cream fail closed test",
      candidates: [{
        id: "usda:cream-cheese",
        productName: "Cheese, cream",
        source: "usda",
        matchScore: 0.975,
        nutrients: {
          kcalPer100g: 350, proteinPer100g: 6, carbsPer100g: 6, fatPer100g: 34,
          saturatedFatPer100g: 20, transFatPer100g: 0, unsaturatedFatPer100g: 14,
          fiberPer100g: 0, sugarPer100g: 4, sodiumPer100g: 300,
          cholesterolPer100g: 100,
        },
      }],
    }])

    expect(decisions.get("cream fail closed test")).toMatchObject({
      candidateId: null,
      confidence: "low",
      verifiedBy: "deterministic",
    })
  })

  it("makes one identity-only call for every ingredient and accepts only supplied IDs", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "google/gemma-3-4b-it",
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              decisions: [
                {
                  ingredient: "Italian seasoning verification test",
                  candidateId: "usda:456",
                  confidence: "high",
                  reason: "Seasoning is the matching food type",
                },
                {
                  ingredient: "whole-wheat rotini verification test",
                  candidateId: "",
                  confidence: "low",
                  reason: "Bagel is not pasta",
                },
              ],
            }),
          },
        }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const decisions = await verifyNutritionCandidates([
      {
        ingredient: "Italian seasoning verification test",
        candidates: [{
          id: "usda:456",
          productName: "Italian seasoning, dried herbs",
          source: "usda",
          matchScore: 0.96,
          dataType: "Foundation",
          nutrients: {
            kcalPer100g: 250, proteinPer100g: 10, carbsPer100g: 40, fatPer100g: 5,
            saturatedFatPer100g: 1, transFatPer100g: 0, unsaturatedFatPer100g: 4,
            fiberPer100g: 20, sugarPer100g: 2, sodiumPer100g: 50,
            cholesterolPer100g: 0,
          },
        }],
      },
      {
        ingredient: "whole-wheat rotini verification test",
        candidates: [{
          id: "usda:789",
          productName: "Bagel, whole wheat",
          source: "usda",
          matchScore: 0.5,
          dataType: "Survey (FNDDS)",
          nutrients: {
            kcalPer100g: 250, proteinPer100g: 10, carbsPer100g: 50, fatPer100g: 2,
            saturatedFatPer100g: 0.5, transFatPer100g: 0, unsaturatedFatPer100g: 1.5,
            fiberPer100g: 4, sugarPer100g: 5, sodiumPer100g: 400,
            cholesterolPer100g: 0,
          },
        }],
      },
    ])

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(decisions.get("Italian seasoning verification test")).toMatchObject({
      candidateId: "usda:456",
      confidence: "high",
      verifiedBy: "llm",
    })
    expect(decisions.get("whole-wheat rotini verification test")?.candidateId).toBeNull()

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    const prompt = body.messages[0].content as string
    expect(prompt).toContain("Do not calculate, scale, sum, convert units")
    expect(prompt).toContain("preparation state")
    expect(prompt).toContain("\"hasEnergy\":true")
    expect(prompt).toContain("\"nutrientFieldCount\":11")
    expect(prompt).not.toContain("kcalPer100g")
    expect(prompt).not.toContain("sodiumPer100g")
    expect(body.response_format.json_schema.name).toBe("nutrition_source_matches")
    expect(body.max_tokens).toBe(1024)
    expect(body.reasoning).toEqual({ effort: "minimal", exclude: true })
  })

  it("rejects a hallucinated candidate ID", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              decisions: [{
                ingredient: "cream hallucinated id test",
                candidateId: "usda:not-supplied",
                confidence: "high",
                reason: "Invented",
              }],
            }),
          },
        }],
      }),
    }))

    const decisions = await verifyNutritionCandidates([{
      ingredient: "cream hallucinated id test",
      candidates: [{
        id: "usda:123",
        productName: "Cream, fluid, light",
        source: "usda",
        matchScore: 0.95,
        nutrients: {
          kcalPer100g: 190, proteinPer100g: 3, carbsPer100g: 4, fatPer100g: 19,
          saturatedFatPer100g: 12, transFatPer100g: 0, unsaturatedFatPer100g: 7,
          fiberPer100g: 0, sugarPer100g: 4, sodiumPer100g: 40,
          cholesterolPer100g: 60,
        },
      }],
    }])

    expect(decisions.get("cream hallucinated id test")).toMatchObject({
      candidateId: null,
      confidence: "low",
    })
  })

  it("retries a transient 429 before accepting a constrained match", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"
    config.llm.maxRetries = 1
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              decisions: [{
                ingredient: "retry match test",
                candidateId: "usda:retry",
                confidence: "high",
                reason: "Exact food identity",
              }],
            }),
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", mockFetch)

    const decisions = await verifyNutritionCandidates([{
      ingredient: "retry match test",
      candidates: [{
        id: "usda:retry",
        productName: "Retry match test",
        source: "usda",
        matchScore: 1,
        nutrients: {
          kcalPer100g: 10, proteinPer100g: 1, carbsPer100g: 1, fatPer100g: 1,
          saturatedFatPer100g: 0, transFatPer100g: 0, unsaturatedFatPer100g: 1,
          fiberPer100g: 0, sugarPer100g: 0, sodiumPer100g: 0,
          cholesterolPer100g: 0,
        },
      }],
    }])

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(decisions.get("retry match test")).toMatchObject({
      candidateId: "usda:retry",
      verifiedBy: "llm",
    })
  })
})
