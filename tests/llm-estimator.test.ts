import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { estimateGrams, estimateNutrients } from "../src/services/llm-estimator.js"
import { initCache, clearLlmCache } from "../src/utils/cache.js"
import { config } from "../src/config.js"

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.structuredOutputs = true
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
})
