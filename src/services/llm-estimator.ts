import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { getCachedLlmEstimate, setCachedLlmEstimate, getCachedLlmNutrients, setCachedLlmNutrients } from "../utils/cache.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type { NutrientSet } from "../types.js"

interface LlmUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface LlmResponse {
  model?: string
  provider?: string
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null
    }
  }>
  usage?: LlmUsage
}

const weightResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "weight_estimate",
    strict: true,
    schema: {
      type: "object",
      properties: {
        grams: { type: "number", minimum: 0 },
      },
      required: ["grams"],
      additionalProperties: false,
    },
  },
}

const nutrientResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "nutrient_estimate",
    strict: true,
    schema: {
      type: "object",
      properties: {
        kcal: { type: "number", minimum: 0 },
        protein: { type: "number", minimum: 0 },
        carbs: { type: "number", minimum: 0 },
        fat: { type: "number", minimum: 0 },
        saturatedFat: { type: "number", minimum: 0 },
        transFat: { type: "number", minimum: 0 },
        fiber: { type: "number", minimum: 0 },
        sugar: { type: "number", minimum: 0 },
        sodium: { type: "number", minimum: 0 },
        cholesterol: { type: "number", minimum: 0 },
      },
      required: [
        "kcal", "protein", "carbs", "fat", "saturatedFat",
        "transFat", "fiber", "sugar", "sodium", "cholesterol",
      ],
      additionalProperties: false,
    },
  },
}

function endpointUrl(): string {
  return `${config.llm.baseUrl.replace(/\/+$/, "")}/${config.llm.endpointUrl.replace(/^\/+/, "")}`
}

function extractContent(data: LlmResponse): string | null {
  const content = data.choices?.[0]?.message?.content
  if (typeof content === "string") return content.trim() || null
  if (!Array.isArray(content)) return null

  const text = content
    .filter((part) => part.type === "text" || part.type == null)
    .map((part) => part.text ?? "")
    .join("")
    .trim()
  return text || null
}

function parseJson(content: string): Record<string, unknown> {
  return JSON.parse(content.replace(/```json\n?|\n?```/g, ""))
}

function hasMeaningfulNutrients(nutrients: NutrientSet): boolean {
  return Object.values(nutrients).some((value) => value !== null && value > 0)
}

function logCompletion(data: LlmResponse, estimateType: "weight" | "nutrients", foodName: string): void {
  logger.info(
    {
      estimateType,
      foodName,
      configuredModel: config.llm.model,
      responseModel: data.model,
      provider: data.provider,
      finishReason: data.choices?.[0]?.finish_reason,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    },
    "LLM estimation response received",
  )
}

export async function estimateGrams(quantity: number, unitName: string, foodName: string): Promise<number | null> {
  if (!config.llm.enabled) return null
  if (!config.llm.apiKey) {
    logger.warn("LLM enabled but LLM_API_KEY is not set")
    return null
  }

  const cached = getCachedLlmEstimate(unitName, foodName)
  if (cached !== undefined) {
    const totalGrams = cached * quantity
    logger.debug({ unitName, foodName, gramsPerUnit: cached, totalGrams }, "LLM estimate cache hit")
    return totalGrams
  }

  const prompt = `Estimate the typical weight in grams for 1 ${unitName} of "${foodName}". For "item", use the typical edible weight of one whole item. Consider typical packaging sizes and food densities. Return 0 only when a reasonable estimate is impossible.`

  try {
    await waitForRateLimit(RateLimitType.Llm)

    const body: Record<string, unknown> = {
      model: config.llm.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: config.llm.weightMaxTokens,
    }
    if (config.llm.structuredOutputs) {
      body.response_format = weightResponseFormat
    }

    const res = await fetch(endpointUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      logger.warn({ status: res.status, unitName, foodName }, "LLM API returned error")
      return null
    }

    const data = await res.json() as LlmResponse
    const content = extractContent(data)
    logCompletion(data, "weight", foodName)

    if (!content) {
      logger.warn(
        {
          unitName,
          foodName,
          configuredModel: config.llm.model,
          responseModel: data.model,
          finishReason: data.choices?.[0]?.finish_reason,
        },
        "LLM returned empty response",
      )
      return null
    }

    const parsed = config.llm.structuredOutputs ? parseJson(content).grams : content
    const num = Number(parsed)

    if (!Number.isFinite(num) || num <= 0) {
      logger.warn({ unitName, foodName }, "LLM returned invalid weight")
      return null
    }

    const gramsPerUnit = num
    const totalGrams = gramsPerUnit * quantity

    setCachedLlmEstimate(unitName, foodName, gramsPerUnit)
    logger.info(
      { unitName, foodName, gramsPerUnit, totalGrams, model: data.model ?? config.llm.model },
      "LLM weight estimate obtained",
    )

    return totalGrams
  } catch (err) {
    logger.warn({ err, unitName, foodName }, "LLM estimation failed")
    return null
  }
}

export async function estimateNutrients(foodName: string): Promise<NutrientSet | null> {
  if (!config.llm.enabled || !config.llm.apiKey) return null

  const cached = getCachedLlmNutrients(foodName)
  if (cached) {
    logger.debug({ foodName }, "LLM nutrient cache hit")
    return cached
  }

  const prompt = `Estimate typical nutritional values per 100g for "${foodName}". Return kcal in kilocalories; protein, carbs, fat, saturatedFat, transFat, fiber, and sugar in grams; sodium and cholesterol in milligrams. Use 0 only when the typical amount is effectively zero.`

  try {
    await waitForRateLimit(RateLimitType.Llm)

    const body: Record<string, unknown> = {
      model: config.llm.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: config.llm.nutrientMaxTokens,
    }
    if (config.llm.structuredOutputs) {
      body.response_format = nutrientResponseFormat
    }

    const res = await fetch(endpointUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      logger.warn({ status: res.status, foodName }, "LLM nutrient API returned error")
      return null
    }

    const data = await res.json() as LlmResponse
    const content = extractContent(data)
    logCompletion(data, "nutrients", foodName)

    if (!content) {
      logger.warn(
        {
          foodName,
          configuredModel: config.llm.model,
          responseModel: data.model,
          finishReason: data.choices?.[0]?.finish_reason,
        },
        "LLM nutrient returned empty response",
      )
      return null
    }

    const json = parseJson(content)

    const nutrients: NutrientSet = {
      kcalPer100g: Number(json.kcal) || null,
      proteinPer100g: Number(json.protein) || null,
      carbsPer100g: Number(json.carbs) || null,
      fatPer100g: Number(json.fat) || null,
      saturatedFatPer100g: Number(json.saturatedFat) || null,
      transFatPer100g: Number(json.transFat) || null,
      unsaturatedFatPer100g: null,
      fiberPer100g: Number(json.fiber) || null,
      sugarPer100g: Number(json.sugar) || null,
      sodiumPer100g: Number(json.sodium) || null,
      cholesterolPer100g: Number(json.cholesterol) || null,
    }

    if (nutrients.fatPer100g !== null) {
      const s = nutrients.saturatedFatPer100g ?? 0
      const t = nutrients.transFatPer100g ?? 0
      nutrients.unsaturatedFatPer100g = Math.round((nutrients.fatPer100g - s - t) * 10) / 10
    }

    if (hasMeaningfulNutrients(nutrients)) {
      setCachedLlmNutrients(foodName, nutrients)
      logger.info(
        {
          foodName,
          kcal: nutrients.kcalPer100g ?? 0,
          model: data.model ?? config.llm.model,
        },
        "LLM nutrient estimate obtained",
      )
      return nutrients
    }

    logger.debug({ foodName }, "LLM returned no meaningful nutrients, discarding")
    return null
  } catch (err) {
    logger.warn({ err, foodName }, "LLM nutrient estimation failed")
    return null
  }
}
