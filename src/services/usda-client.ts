import { config } from "../config.js"
import type { NutritionLookupResult, NutrientSet } from "../types.js"
import { getCachedNutrients, setCachedNutrients } from "../utils/cache.js"
import { logger } from "../utils/logger.js"
import { RateLimitType, waitForRateLimit } from "../utils/rate-limiter.js"

interface UsdaNutrient {
  nutrientId: number
  nutrientName: string
  unitName: string
  value: number
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
  const nutrient = food.foodNutrients?.find((item) => item.nutrientId === nutrientId)
  if (!nutrient || !Number.isFinite(nutrient.value)) return null
  if (target === "kcal") {
    return nutrient.unitName.toLowerCase() === "kj"
      ? nutrient.value / 4.184
      : nutrient.value
  }
  return convertMass(nutrient.value, nutrient.unitName, target)
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

async function search(foodName: string): Promise<UsdaFood | null> {
  const params = new URLSearchParams({
    api_key: config.usda.apiKey,
    query: foodName,
    pageSize: "5",
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
        return null
      }
      const data = (await response.json()) as UsdaSearchResponse
      return data.foods?.find((food) => food.foodNutrients?.length) ?? null
    } catch (error) {
      if (attempt === config.usda.maxRetries) {
        logger.warn({ foodName, error }, "USDA search failed")
        return null
      }
    }
  }
  return null
}

export async function lookupUsdaNutrients(
  foodName: string,
): Promise<NutritionLookupResult> {
  if (!config.usda.apiKey) {
    return { nutrients: null, matched: false, productName: null, source: "usda" }
  }

  const cacheKey = `usda:${foodName}`
  const cached = getCachedNutrients(cacheKey)
  if (cached) {
    return {
      nutrients: cached,
      matched: true,
      productName: foodName,
      source: "usda",
    }
  }

  const food = await search(foodName)
  if (!food) {
    return { nutrients: null, matched: false, productName: null, source: "usda" }
  }

  const nutrients = extractNutrients(food)
  if (!hasMeaningfulNutrients(nutrients)) {
    return {
      nutrients: null,
      matched: false,
      productName: food.description,
      source: "usda",
    }
  }

  setCachedNutrients(cacheKey, nutrients)
  logger.info(
    {
      foodName,
      product: food.description,
      fdcId: food.fdcId,
      dataType: food.dataType,
    },
    "USDA match found",
  )
  return {
    nutrients,
    matched: true,
    productName: food.description,
    source: "usda",
  }
}
