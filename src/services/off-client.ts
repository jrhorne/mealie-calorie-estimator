import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import {
  getCachedNutrients,
  getCachedProviderCandidates,
  setCachedProviderCandidates,
} from "../utils/cache.js"
import { foodMatchIsPlausible, scoreFoodMatch } from "../utils/food-match.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type {
  NutritionCandidate,
  NutritionLookupResult,
  OffNutriments,
  OffProduct,
  OffSearchResult,
  NutrientSet,
} from "../types.js"

const OFF_NUTRIENT_FIELDS = ["code", "product_name", "nutriments"].join(",")

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

const KNOWN_SALT_NAMES = new Set([
  "salt",
  "table salt",
  "sea salt",
  "kosher salt",
  "fine salt",
  "coarse salt",
  "iodized salt",
  "iodised salt",
  "fleur de sel",
])

const TABLE_SALT_NUTRIENTS: NutrientSet = {
  kcalPer100g: 0,
  proteinPer100g: 0,
  carbsPer100g: 0,
  fatPer100g: 0,
  saturatedFatPer100g: 0,
  transFatPer100g: 0,
  unsaturatedFatPer100g: 0,
  fiberPer100g: 0,
  sugarPer100g: 0,
  sodiumPer100g: 38_758,
  cholesterolPer100g: 0,
}

function knownNutrients(foodName: string): NutrientSet | null {
  const normalized = foodName.toLowerCase().replace(/\s+/g, " ").trim()
  return KNOWN_SALT_NAMES.has(normalized) ? { ...TABLE_SALT_NUTRIENTS } : null
}

async function fetchWithRetry(url: string, query: string): Promise<Response | null> {
  const { maxRetries, retryBackoffMs, userAgent } = config.openFoodFacts
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = retryBackoffMs * 2 ** (attempt - 1)
      logger.debug({ query, attempt, delay }, "Retrying OFF search after backoff")
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    try {
      const res = await fetch(url, { headers: { "User-Agent": userAgent } })
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) {
        return res
      }
      lastResponse = res
      logger.debug({ query, attempt, status: res.status }, "OFF search returned retryable status")
    } catch (err) {
      lastResponse = null
      logger.debug({ query, attempt, err: (err as Error).message }, "OFF search request failed")
    }
  }

  return lastResponse
}

function extractNutrients(n: OffNutriments): NutrientSet {
  const fat = n["fat_100g"] ?? null
  const saturated = n["saturated-fat_100g"] ?? null
  const trans = n["trans-fat_100g"] ?? null

  let unsaturated: number | null = null
  if (fat !== null) {
    const s = saturated ?? 0
    const t = trans ?? 0
    unsaturated = Math.round((fat - s - t) * 10) / 10
  }

  return {
    kcalPer100g: n["energy-kcal_100g"] ?? null,
    proteinPer100g: n["proteins_100g"] ?? null,
    carbsPer100g: n["carbohydrates_100g"] ?? null,
    fatPer100g: fat,
    saturatedFatPer100g: saturated,
    transFatPer100g: trans,
    unsaturatedFatPer100g: unsaturated,
    fiberPer100g: n["fiber_100g"] ?? null,
    sugarPer100g: n["sugars_100g"] ?? null,
    sodiumPer100g: n["sodium_100g"] == null ? null : n["sodium_100g"] * 1000,
    cholesterolPer100g: n["cholesterol_100g"] == null ? null : n["cholesterol_100g"] * 1000,
  }
}

async function searchProducts(query: string): Promise<OffProduct[]> {
  const params = new URLSearchParams({
    q: query,
    langs: config.openFoodFacts.language,
    page_size: "5",
    fields: OFF_NUTRIENT_FIELDS,
  })

  const url = `${config.openFoodFacts.searchBaseUrl}/search?${params}`

  await waitForRateLimit(RateLimitType.Search)

  const res = await fetchWithRetry(url, query)

  if (!res) {
    logger.warn({ query }, "OFF search failed after retries")
    return []
  }

  if (!res.ok) {
    logger.warn({ status: res.status, query }, "OFF search returned error")
    return []
  }

  let data: OffSearchResult
  try {
    data = (await res.json()) as OffSearchResult
  } catch {
    logger.warn({ query }, "OFF returned non-JSON response")
    return []
  }

  if (!data.hits || data.hits.length === 0) {
    return []
  }

  return data.hits
}

export async function lookupOffCandidates(
  foodName: string,
  unitName?: string,
): Promise<NutritionCandidate[]> {
  const known = knownNutrients(foodName)
  if (known) {
    logger.debug({ foodName }, "Known nutrient composition found")
    return [{
      id: "known:table-salt",
      nutrients: known,
      productName: "Known composition: table salt",
      source: "known",
      matchScore: 1,
      dataType: "known",
    }]
  }

  let searchTerm = foodName
  if (unitName && searchTerm.toLowerCase().startsWith(unitName.toLowerCase())) {
    searchTerm = searchTerm.slice(unitName.length).trim()
  }

  const cacheKey = `openfoodfacts:${searchTerm}`
  const cachedCandidates = getCachedProviderCandidates(cacheKey)
  if (cachedCandidates) {
    logger.debug({ foodName }, "OFF candidate cache hit")
    return cachedCandidates
  }

  const cached = getCachedNutrients(cacheKey)
  if (cached) {
    logger.debug({ foodName }, "Legacy OFF nutrient cache hit")
    return [{
      id: `openfoodfacts:legacy:${searchTerm.toLowerCase()}`,
      nutrients: cached,
      productName: searchTerm,
      source: "openfoodfacts",
      matchScore: 1,
      dataType: "legacy-cache",
    }]
  }

  const products = await searchProducts(searchTerm)

  if (products.length === 0) {
    logger.debug({ foodName }, "No OFF match found")
    return []
  }

  const candidates: NutritionCandidate[] = []
  for (const [index, product] of products.entries()) {
    if (!product.nutriments || !product.product_name) continue
    const nutrients = extractNutrients(product.nutriments)
    if (nutrients.kcalPer100g === null) continue
    const matchScore = scoreFoodMatch(searchTerm, product.product_name)
    if (!foodMatchIsPlausible(matchScore)) {
      logger.debug(
        { foodName, searchTerm, product: product.product_name, matchScore },
        "Rejected unrelated OFF product candidate",
      )
      continue
    }
    candidates.push({
      id: `openfoodfacts:${product.code ?? `${product.product_name}:${index}`}`,
      nutrients,
      productName: product.product_name,
      source: "openfoodfacts",
      matchScore,
      dataType: "branded",
    })
  }

  candidates.sort((left, right) => right.matchScore - left.matchScore)
  const limited = candidates.slice(0, 3)
  setCachedProviderCandidates(cacheKey, limited)
  return limited
}

export async function lookupOffCandidateById(
  providerId: string,
): Promise<NutritionCandidate | null> {
  const prefix = "openfoodfacts:"
  if (!providerId.startsWith(prefix)) return null
  const code = providerId.slice(prefix.length).trim()
  if (!code || code.startsWith("legacy:")) return null

  const cacheKey = `openfoodfacts:id:${code}`
  const cached = getCachedProviderCandidates(cacheKey)
  if (cached?.[0]) return cached[0]

  const url =
    `${config.openFoodFacts.baseUrl.replace(/\/+$/, "")}/api/v2/product/`
    + `${encodeURIComponent(code)}?fields=${encodeURIComponent(OFF_NUTRIENT_FIELDS)}`
  await waitForRateLimit(RateLimitType.Product)
  const res = await fetchWithRetry(url, providerId)
  if (!res?.ok) {
    logger.warn({ providerId, status: res?.status }, "OFF product lookup returned error")
    return null
  }

  let product: OffProduct | undefined
  try {
    const data = (await res.json()) as { product?: OffProduct }
    product = data.product
  } catch {
    logger.warn({ providerId }, "OFF product lookup returned non-JSON response")
    return null
  }

  if (!product?.nutriments || !product.product_name) return null
  const nutrients = extractNutrients(product.nutriments)
  if (nutrients.kcalPer100g === null) return null
  const candidate: NutritionCandidate = {
    id: providerId,
    nutrients,
    productName: product.product_name,
    source: "openfoodfacts",
    matchScore: 1,
    dataType: "branded",
  }
  setCachedProviderCandidates(cacheKey, [candidate])
  return candidate
}

export async function lookupNutrients(
  foodName: string,
  unitName?: string,
): Promise<NutritionLookupResult> {
  const candidates = await lookupOffCandidates(foodName, unitName)
  const candidate = candidates[0]
  if (!candidate) {
    return {
      nutrients: null,
      matched: false,
      productName: null,
      source: "openfoodfacts",
    }
  }
  return {
    nutrients: candidate.nutrients,
    matched: true,
    productName: candidate.productName,
    source: candidate.source,
    providerId: candidate.id,
    matchScore: candidate.matchScore,
    dataType: candidate.dataType,
  }
}
