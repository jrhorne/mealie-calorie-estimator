import { config } from "../config.js"
import type {
  NutritionCandidate,
  NutritionLookupResult,
  NutrientSet,
} from "../types.js"
import {
  getCachedProviderCandidates,
  setCachedProviderCandidates,
} from "../utils/cache.js"
import { foodMatchIsPlausible, scoreFoodMatch } from "../utils/food-match.js"
import { logger } from "../utils/logger.js"
import { RateLimitType, waitForRateLimit } from "../utils/rate-limiter.js"

interface UsdaNutrient {
  nutrientId?: number
  nutrientName?: string
  unitName?: string
  value?: number
  amount?: number
  nutrient?: {
    id: number
    name?: string
    unitName: string
  }
}

interface UsdaFood {
  fdcId: number
  description: string
  dataType: string
  foodNutrients?: UsdaNutrient[]
}

interface UsdaSearchResponse {
  foods?: UsdaFood[]
}

const NUTRIENT_IDS = {
  calories: 1008,
  protein: 1003,
  carbs: 1005,
  fat: 1004,
  fiber: 1079,
  sugar: 2000,
  sodium: 1093,
  saturatedFat: 1258,
  transFat: 1257,
  cholesterol: 1253,
} as const

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

function convertMass(value: number, unitName: string, target: "g" | "mg"): number {
  const unit = unitName.toLowerCase()
  if (target === "g") {
    if (unit === "mg") return value / 1000
    if (unit === "ug" || unit === "µg") return value / 1_000_000
    return value
  }
  if (unit === "g") return value * 1000
  if (unit === "ug" || unit === "µg") return value / 1000
  return value
}

function valueFor(
  food: UsdaFood,
  nutrientId: number,
  target: "g" | "mg" | "kcal",
): number | null {
  const nutrient = food.foodNutrients?.find(
    (item) => (item.nutrientId ?? item.nutrient?.id) === nutrientId,
  )
  const value = nutrient?.value ?? nutrient?.amount
  const unitName = nutrient?.unitName ?? nutrient?.nutrient?.unitName
  if (!nutrient || !Number.isFinite(value) || !unitName) return null
  if (target === "kcal") {
    return unitName.toLowerCase() === "kj"
      ? value! / 4.184
      : value!
  }
  return convertMass(value!, unitName, target)
}

function extractNutrients(food: UsdaFood): NutrientSet {
  const fat = valueFor(food, NUTRIENT_IDS.fat, "g")
  const saturatedFat = valueFor(food, NUTRIENT_IDS.saturatedFat, "g")
  const transFat = valueFor(food, NUTRIENT_IDS.transFat, "g")
  const unsaturatedFat =
    fat === null
      ? null
      : Math.max(0, Math.round((fat - (saturatedFat ?? 0) - (transFat ?? 0)) * 10) / 10)

  return {
    kcalPer100g: valueFor(food, NUTRIENT_IDS.calories, "kcal"),
    proteinPer100g: valueFor(food, NUTRIENT_IDS.protein, "g"),
    carbsPer100g: valueFor(food, NUTRIENT_IDS.carbs, "g"),
    fatPer100g: fat,
    saturatedFatPer100g: saturatedFat,
    transFatPer100g: transFat,
    unsaturatedFatPer100g: unsaturatedFat,
    fiberPer100g: valueFor(food, NUTRIENT_IDS.fiber, "g"),
    sugarPer100g: valueFor(food, NUTRIENT_IDS.sugar, "g"),
    sodiumPer100g: valueFor(food, NUTRIENT_IDS.sodium, "mg"),
    cholesterolPer100g: valueFor(food, NUTRIENT_IDS.cholesterol, "mg"),
  }
}

function hasMeaningfulNutrients(nutrients: NutrientSet): boolean {
  return Object.values(nutrients).some((value) => value !== null && value > 0)
}

async function search(foodName: string): Promise<UsdaFood[]> {
  const params = new URLSearchParams({
    api_key: config.usda.apiKey,
    query: foodName,
    pageSize: "10",
    dataType: "Foundation,SR Legacy,Survey (FNDDS)",
  })
  const url = `${config.usda.baseUrl.replace(/\/+$/, "")}/foods/search?${params}`

  for (let attempt = 0; attempt <= config.usda.maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.usda.retryBackoffMs * 2 ** (attempt - 1)),
      )
    }

    await waitForRateLimit(RateLimitType.Usda)
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(config.usda.timeoutMs),
      })
      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < config.usda.maxRetries) {
          continue
        }
        logger.warn({ foodName, status: response.status }, "USDA search returned error")
        return []
      }
      const data = (await response.json()) as UsdaSearchResponse
      return data.foods ?? []
    } catch (error) {
      if (attempt === config.usda.maxRetries) {
        logger.warn({ foodName, error }, "USDA search failed")
        return []
      }
    }
  }
  return []
}

export async function lookupUsdaCandidates(
  foodName: string,
): Promise<NutritionCandidate[]> {
  if (!config.usda.apiKey) return []

  const cacheKey = `usda:${foodName}`
  const cached = getCachedProviderCandidates(cacheKey)
  if (cached) return cached

  const foods = await search(foodName)
  if (foods.length === 0) {
    return []
  }

  const candidates: NutritionCandidate[] = []
  for (const food of foods) {
    if (!food.foodNutrients?.length) continue
    const nutrients = extractNutrients(food)
    if (!hasMeaningfulNutrients(nutrients)) continue
    const matchScore = scoreFoodMatch(foodName, food.description, food.dataType)
    if (!foodMatchIsPlausible(matchScore)) {
      logger.debug(
        {
          foodName,
          product: food.description,
          fdcId: food.fdcId,
          dataType: food.dataType,
          matchScore,
        },
        "Rejected unrelated USDA candidate",
      )
      continue
    }
    candidates.push({
      id: `usda:${food.fdcId}`,
      nutrients,
      productName: food.description,
      source: "usda",
      matchScore,
      dataType: food.dataType,
    })
  }

  candidates.sort((left, right) => right.matchScore - left.matchScore)
  const limited = candidates.slice(0, 3)
  setCachedProviderCandidates(cacheKey, limited)
  logger.info({
    foodName,
    candidates: limited.map((candidate) => ({
      id: candidate.id,
      product: candidate.productName,
      dataType: candidate.dataType,
      matchScore: candidate.matchScore,
    })),
  }, "USDA candidates found")
  return limited
}

export async function lookupUsdaCandidateById(
  providerId: string,
): Promise<NutritionCandidate | null> {
  if (!config.usda.apiKey || !providerId.startsWith("usda:")) return null
  const idText = providerId.slice("usda:".length).trim()
  if (!/^\d+$/.test(idText)) return null

  const cacheKey = `usda:id:${idText}`
  const cached = getCachedProviderCandidates(cacheKey)
  if (cached?.[0]) return cached[0]

  const url =
    `${config.usda.baseUrl.replace(/\/+$/, "")}/food/${idText}`
    + `?api_key=${encodeURIComponent(config.usda.apiKey)}`
  let food: UsdaFood | null = null
  for (let attempt = 0; attempt <= config.usda.maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, config.usda.retryBackoffMs * 2 ** (attempt - 1)),
      )
    }
    await waitForRateLimit(RateLimitType.Usda)
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(config.usda.timeoutMs),
      })
      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < config.usda.maxRetries) continue
        logger.warn({ providerId, status: response.status }, "USDA food lookup returned error")
        return null
      }
      food = (await response.json()) as UsdaFood
      break
    } catch (error) {
      if (attempt === config.usda.maxRetries) {
        logger.warn({ providerId, error }, "USDA food lookup failed")
        return null
      }
    }
  }

  if (!food || food.fdcId !== Number(idText) || !food.foodNutrients?.length) return null
  const nutrients = extractNutrients(food)
  if (!hasMeaningfulNutrients(nutrients)) return null
  const candidate: NutritionCandidate = {
    id: providerId,
    nutrients,
    productName: food.description,
    source: "usda",
    matchScore: 1,
    dataType: food.dataType,
  }
  setCachedProviderCandidates(cacheKey, [candidate])
  return candidate
}

export async function lookupUsdaNutrients(
  foodName: string,
): Promise<NutritionLookupResult> {
  const candidates = await lookupUsdaCandidates(foodName)
  const candidate = candidates[0]
  if (!candidate) {
    return { nutrients: null, matched: false, productName: null, source: "usda" }
  }
  return {
    nutrients: candidate.nutrients,
    matched: true,
    productName: candidate.productName,
    source: "usda",
    providerId: candidate.id,
    matchScore: candidate.matchScore,
    dataType: candidate.dataType,
  }
}
