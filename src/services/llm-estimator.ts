import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import {
  getCachedLlmEstimate,
  getCachedLlmMatch,
  getCachedLlmNutrients,
  setCachedLlmEstimate,
  setCachedLlmMatch,
  setCachedLlmNutrients,
} from "../utils/cache.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type {
  NutritionCandidate,
  NutritionCandidateDecision,
  NutritionCandidateGroup,
  NutritionConfidence,
  NutrientSet,
} from "../types.js"

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

const RETRYABLE_LLM_STATUS = new Set([429, 500, 502, 503, 504])

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

function matchResponseFormat(groups: NutritionCandidateGroup[]): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "nutrition_source_matches",
      strict: true,
      schema: {
        type: "object",
        properties: {
          decisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ingredient: {
                  type: "string",
                  enum: groups.map((group) => group.ingredient),
                },
                candidateId: { type: "string" },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
                reason: { type: "string" },
              },
              required: ["ingredient", "candidateId", "confidence", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["decisions"],
        additionalProperties: false,
      },
    },
  }
}

function endpointUrl(): string {
  return `${config.llm.baseUrl.replace(/\/+$/, "")}/${config.llm.endpointUrl.replace(/^\/+/, "")}`
}

async function fetchLlm(
  body: Record<string, unknown>,
  operation: "weight" | "nutrients" | "matches",
): Promise<Response | null> {
  for (let attempt = 0; attempt <= config.llm.maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = config.llm.retryBackoffMs * 2 ** (attempt - 1)
      await new Promise((resolve) => setTimeout(resolve, Math.min(backoff, 30_000)))
    }
    await waitForRateLimit(RateLimitType.Llm)
    try {
      const response = await fetch(endpointUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.llm.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.llm.timeoutMs),
      })
      if (
        response.ok
        || !RETRYABLE_LLM_STATUS.has(response.status)
        || attempt === config.llm.maxRetries
      ) {
        return response
      }
      logger.warn(
        { operation, status: response.status, attempt: attempt + 1 },
        "Retrying transient LLM API response",
      )
    } catch (error) {
      if (attempt === config.llm.maxRetries) {
        logger.warn({ operation, error }, "LLM API request failed after retries")
        return null
      }
      logger.warn(
        { operation, attempt: attempt + 1, error },
        "Retrying failed LLM API request",
      )
    }
  }
  return null
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

function logCompletion(
  data: LlmResponse,
  estimateType: "weight" | "nutrients" | "matches",
  foodName: string,
): void {
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

function matchCacheKey(group: NutritionCandidateGroup): string {
  const signature = group.candidates
    .map((candidate) => `${candidate.id}:${candidate.matchScore}`)
    .sort()
    .join("|")
  return [
    "v2-source-quality",
    config.llm.model,
    group.ingredient,
    group.lookupQuery ?? group.ingredient,
    signature,
  ].join("|")
}

function nutrientFieldCount(candidate: NutritionCandidate): number {
  return Object.values(candidate.nutrients)
    .filter((value) => value !== null && Number.isFinite(value))
    .length
}

function applyReasoning(body: Record<string, unknown>): void {
  if (!config.llm.reasoningEffort) return
  body.reasoning = {
    effort: config.llm.reasoningEffort,
    exclude: config.llm.reasoningExclude,
  }
}

function capMatchConfidence(
  requested: NutritionConfidence,
  candidate: NutritionCandidate,
): NutritionConfidence {
  if (requested === "low" || candidate.matchScore < 0.65) return "low"
  if (requested === "medium" || candidate.matchScore < 0.9) return "medium"
  return "high"
}

function deterministicDecision(group: NutritionCandidateGroup): NutritionCandidateDecision {
  const candidate = [...group.candidates].sort(
    (left, right) => right.matchScore - left.matchScore,
  )[0]
  if (candidate && candidate.matchScore === 1) {
    return {
      ingredient: group.ingredient,
      candidateId: candidate.id,
      confidence: "high",
      reason: "Exact deterministic identity match",
      verifiedBy: "deterministic",
    }
  }
  return {
    ingredient: group.ingredient,
    candidateId: null,
    confidence: "low",
    reason: "No LLM verification and no exact deterministic identity match",
    verifiedBy: "deterministic",
  }
}

export async function verifyNutritionCandidates(
  groups: NutritionCandidateGroup[],
): Promise<Map<string, NutritionCandidateDecision>> {
  const decisions = new Map<string, NutritionCandidateDecision>()
  const pending: NutritionCandidateGroup[] = []

  for (const group of groups) {
    if (group.candidates.length === 0) {
      decisions.set(group.ingredient, {
        ingredient: group.ingredient,
        candidateId: null,
        confidence: "low",
        reason: "No plausible structured-source candidates",
        verifiedBy: "deterministic",
      })
      continue
    }
    const cached = getCachedLlmMatch(matchCacheKey(group))
    if (cached) {
      decisions.set(group.ingredient, { ...cached, verifiedBy: "cache" })
    } else {
      pending.push(group)
    }
  }

  if (pending.length === 0) return decisions

  if (!config.llm.enabled || !config.llm.apiKey) {
    for (const group of pending) {
      decisions.set(group.ingredient, deterministicDecision(group))
    }
    return decisions
  }

  const prompt = [
    "Select the structured-source candidate that represents each culinary ingredient and its preparation state, or reject all by returning an empty candidateId.",
    "Prefer a matching candidate with complete standard nutrition fields. Reject cooked, prepared, composite, flavored, or different-variety records when the ingredient or lookup query requires another state. A product merely flavored with the ingredient is not the ingredient itself.",
    "For a generic commodity or pantry ingredient, prefer a matching USDA Foundation or SR Legacy record over a branded database record. Use a branded record when the ingredient names that brand or product, or when no authoritative generic record matches.",
    "Only decide identity. Do not calculate, scale, sum, convert units, estimate servings, or provide nutrition values.",
    "Candidate IDs must be copied exactly from the supplied list.",
    JSON.stringify(
      pending.map((group) => ({
        ingredient: group.ingredient,
        lookupQuery: group.lookupQuery ?? group.ingredient,
        candidates: group.candidates.map((candidate) => ({
          candidateId: candidate.id,
          name: candidate.productName,
          source: candidate.source,
          dataType: candidate.dataType ?? null,
          lexicalScore: candidate.matchScore,
          hasEnergy: candidate.nutrients.kcalPer100g !== null,
          nutrientFieldCount: nutrientFieldCount(candidate),
        })),
      })),
    ),
  ].join("\n")

  try {
    const body: Record<string, unknown> = {
      model: config.llm.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: config.llm.matchMaxTokens,
    }
    if (config.llm.structuredOutputs) body.response_format = matchResponseFormat(pending)
    applyReasoning(body)

    const response = await fetchLlm(body, "matches")
    if (!response?.ok) {
      logger.warn({ status: response?.status }, "LLM candidate verification returned error")
      for (const group of pending) {
        decisions.set(group.ingredient, deterministicDecision(group))
      }
      return decisions
    }

    const data = await response.json() as LlmResponse
    const content = extractContent(data)
    logCompletion(data, "matches", `${pending.length} ingredients`)
    if (!content) throw new Error("LLM candidate verification returned empty content")

    const parsed = parseJson(content)
    const returned = Array.isArray(parsed.decisions)
      ? parsed.decisions as Array<Record<string, unknown>>
      : []

    for (const group of pending) {
      const raw = returned.find((item) => item.ingredient === group.ingredient)
      const requestedId = typeof raw?.candidateId === "string"
        ? raw.candidateId.trim()
        : ""
      const candidate = group.candidates.find((item) => item.id === requestedId)
      const rawConfidence = raw?.confidence === "high" || raw?.confidence === "medium"
        ? raw.confidence
        : "low"
      const decision: NutritionCandidateDecision = candidate
        ? {
            ingredient: group.ingredient,
            candidateId: candidate.id,
            confidence: capMatchConfidence(rawConfidence, candidate),
            reason: typeof raw?.reason === "string"
              ? raw.reason.slice(0, 500)
              : "LLM selected candidate without a reason",
            verifiedBy: "llm",
          }
        : {
            ingredient: group.ingredient,
            candidateId: null,
            confidence: "low",
            reason: requestedId
              ? "LLM returned an unknown candidate ID"
              : typeof raw?.reason === "string"
                ? raw.reason.slice(0, 500)
                : "LLM rejected all candidates",
            verifiedBy: "llm",
          }
      decisions.set(group.ingredient, decision)
      setCachedLlmMatch(matchCacheKey(group), decision)
    }
  } catch (error) {
    logger.warn({ error }, "LLM candidate verification failed")
    for (const group of pending) {
      decisions.set(group.ingredient, deterministicDecision(group))
    }
  }

  return decisions
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

  const prompt = `Estimate only the typical weight in grams for exactly 1 ${unitName} of "${foodName}". For "item", use the typical edible weight of one whole item. Do not multiply by recipe quantity and do not calculate nutrition. Return 0 only when a reasonable estimate is impossible.`

  try {
    const body: Record<string, unknown> = {
      model: config.llm.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: config.llm.weightMaxTokens,
    }
    if (config.llm.structuredOutputs) {
      body.response_format = weightResponseFormat
    }
    applyReasoning(body)

    const res = await fetchLlm(body, "weight")

    if (!res?.ok) {
      logger.warn({ status: res?.status, unitName, foodName }, "LLM API returned error")
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
    const body: Record<string, unknown> = {
      model: config.llm.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: config.llm.nutrientMaxTokens,
    }
    if (config.llm.structuredOutputs) {
      body.response_format = nutrientResponseFormat
    }
    applyReasoning(body)

    const res = await fetchLlm(body, "nutrients")

    if (!res?.ok) {
      logger.warn({ status: res?.status, foodName }, "LLM nutrient API returned error")
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
