import crypto from "node:crypto"
import type {
  MealieRecipe, IngredientMatch, EstimateResult, NutritionPatch,
  NutrientSet, MealieNutrition, NutritionCandidate, NutritionOverride,
} from "../types.js"
import { config } from "../config.js"
import { convertToGrams } from "./unit-converter.js"
import { lookupOffCandidates } from "./off-client.js"
import { lookupUsdaCandidates } from "./usda-client.js"
import {
  estimateGrams,
  verifyNutritionCandidates,
} from "./llm-estimator.js"
import {
  addScaledNutrients,
  divideNutrients,
  emptyNutrients,
} from "./nutrition-math.js"
import { logger } from "../utils/logger.js"

export function computeIngredientHash(recipe: MealieRecipe): string {
  const parts: string[] = []

  for (const ing of recipe.recipeIngredient) {
    const qty = ing.quantity ?? 0
    const unitName = ing.unit?.name ?? ""
    const foodName = ing.food?.name ?? ""
    parts.push(`${qty}|${unitName}|${foodName}`)
  }

  parts.sort()
  parts.push(`yield:${recipe.recipeYield ?? ""}`)
  parts.push(`servings:${recipe.recipeServings ?? ""}`)
  parts.push(`overrides:${JSON.stringify(getNutritionOverrides(recipe))}`)
  const hash = crypto.createHash("sha256").update(parts.join(",")).digest("hex")
  return hash
}

export function getNutritionOverrides(
  recipe: MealieRecipe,
): Record<string, NutritionOverride> {
  const raw = recipe.extras?.calorie_estimator_overrides
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([name, value]) => {
          if (typeof value === "string" && value.trim()) {
            return [[name.toLowerCase().trim(), { query: value.trim() }]]
          }
          if (typeof value !== "object" || value === null) return []
          const candidate = value as Record<string, unknown>
          const override: NutritionOverride = {}
          if (typeof candidate.query === "string" && candidate.query.trim()) {
            override.query = candidate.query.trim()
          }
          const grams = Number(candidate.grams)
          if (Number.isFinite(grams) && grams > 0) override.grams = grams
          if (
            typeof candidate.providerId === "string"
            && candidate.providerId.trim()
          ) {
            override.providerId = candidate.providerId.trim()
          }
          return override.query || override.grams || override.providerId
            ? [[name.toLowerCase().trim(), override]]
            : []
        }),
    )
  } catch {
    logger.warn({ slug: recipe.slug }, "Ignoring invalid nutrition override JSON")
    return {}
  }
}

export function shouldEstimate(recipe: MealieRecipe): boolean {
  if (config.estimate.strategy === "all") return true
  const tagName = config.estimate.tag.toLowerCase()
  return (recipe.tags || []).some(t => t.slug === tagName || t.name.toLowerCase() === tagName)
}

export function parseYield(recipeYield: string | null): number | null {
  if (!recipeYield) return null

  const rangeMatch = recipeYield.match(/(\d+)\s*[-–]\s*(\d+)/)
  if (rangeMatch) {
    return Math.round((parseInt(rangeMatch[1], 10) + parseInt(rangeMatch[2], 10)) / 2)
  }

  const numMatch = recipeYield.match(/(\d+(?:[.,]\d+)?)/)
  if (numMatch) {
    return parseFloat(numMatch[1].replace(",", "."))
  }

  return null
}

export async function estimateRecipe(recipe: MealieRecipe): Promise<EstimateResult> {
  interface PreparedIngredient {
    name: string
    lookupQuery: string
    grams: number | null
    weightSource: "unit-converter" | "llm" | "override"
    providerId?: string
    candidates: NutritionCandidate[]
  }

  const matchedIngredients: IngredientMatch[] = []
  const unmatchedNames: string[] = []
  let totalNutrients = emptyNutrients()
  const preparedIngredients: PreparedIngredient[] = []
  const overrides = getNutritionOverrides(recipe)

  for (const ing of recipe.recipeIngredient) {
    const foodName = ing.food?.name
    const quantity = ing.quantity

    if (!foodName || quantity == null || quantity <= 0) {
      continue
    }

    const override = overrides[foodName.toLowerCase().trim()]
    const lookupQuery = override?.query ?? foodName
    let grams = override?.grams ?? convertToGrams(quantity, ing.unit, foodName)
    let weightSource: PreparedIngredient["weightSource"] = "unit-converter"
    if (override?.grams !== undefined) weightSource = "override"

    if (grams === null) {
      const unitName = ing.unit?.name ?? "item"
      const llmGrams = await estimateGrams(quantity, unitName, foodName)
      if (llmGrams !== null) {
        grams = llmGrams
        weightSource = "llm"
      }
    }

    if (grams === null) {
      preparedIngredients.push({
        name: foodName,
        lookupQuery,
        grams: null,
        weightSource,
        providerId: override?.providerId,
        candidates: [],
      })
      continue
    }

    const offCandidates = await lookupOffCandidates(lookupQuery, ing.unit?.name)
    const rankedCandidates = offCandidates.some((candidate) => candidate.source === "known")
      ? offCandidates
      : [
          ...offCandidates,
          ...await lookupUsdaCandidates(lookupQuery),
        ]
          .sort((left, right) => right.matchScore - left.matchScore)
    const candidates = override?.providerId
      ? rankedCandidates
      : rankedCandidates.slice(0, 5)
    preparedIngredients.push({
      name: foodName,
      lookupQuery,
      grams,
      weightSource,
      providerId: override?.providerId,
      candidates,
    })
  }

  const decisions = await verifyNutritionCandidates(
    preparedIngredients
      .filter((ingredient) =>
        ingredient.grams !== null && ingredient.providerId === undefined
      )
      .map((ingredient) => ({
        ingredient: ingredient.name,
        lookupQuery: ingredient.lookupQuery,
        candidates: ingredient.candidates,
      })),
  )

  for (const ingredient of preparedIngredients) {
    const {
      name: foodName,
      lookupQuery,
      grams,
      weightSource,
      providerId,
      candidates,
    } = ingredient
    if (grams === null) {
      unmatchedNames.push(foodName)
      matchedIngredients.push({
        name: foodName,
        lookupQuery,
        grams: null,
        matched: false,
        nutrients: null,
        confidence: "low",
        weightSource,
      })
      continue
    }

    const overrideCandidate = providerId
      ? candidates.find((item) => item.id === providerId)
      : undefined
    const decision = providerId
      ? {
          ingredient: foodName,
          candidateId: overrideCandidate?.id ?? null,
          confidence: overrideCandidate ? "high" as const : "low" as const,
          reason: overrideCandidate
            ? "Manual structured-source provider override"
            : "Manual provider override was not found in current candidates",
          verifiedBy: "override" as const,
        }
      : decisions.get(foodName)
    const candidate = decision?.candidateId
      ? candidates.find((item) => item.id === decision.candidateId)
      : undefined

    if (!candidate) {
      unmatchedNames.push(foodName)
      matchedIngredients.push({
        name: foodName,
        lookupQuery,
        grams,
        matched: false,
        nutrients: null,
        confidence: "low",
        verificationReason: decision?.reason ?? "No structured-source match",
        verifiedBy: decision?.verifiedBy ?? "deterministic",
        weightSource,
      })
      continue
    }

    totalNutrients = addScaledNutrients(totalNutrients, candidate.nutrients, grams)
    matchedIngredients.push({
      name: foodName,
      lookupQuery,
      grams,
      matched: true,
      nutrients: candidate.nutrients,
      llmEstimated: weightSource === "llm",
      nutritionSource: candidate.source,
      confidence: weightSource === "llm" ? "low" : decision?.confidence ?? "low",
      productName: candidate.productName,
      providerId: candidate.id,
      matchScore: candidate.matchScore,
      verificationReason: decision?.reason ?? null,
      verifiedBy: decision?.verifiedBy ?? null,
      weightSource,
    })
  }

  const servings = parseYield(recipe.recipeYield) ?? recipe.recipeServings
  const perServingNutrients = servings && servings > 0
    ? divideNutrients(totalNutrients, servings)
    : emptyNutrients()

  const result: EstimateResult = {
    slug: recipe.slug,
    servings,
    totalNutrients,
    perServingNutrients,
    matchedCount: matchedIngredients.filter((i) => i.matched).length,
    unmatchedCount: unmatchedNames.length,
    unmatchedIngredients: unmatchedNames,
    matchedIngredients,
  }

  logger.info(
    {
      slug: recipe.slug,
      servings,
      totalKcal: totalNutrients.kcalPer100g,
      kcalPerServing: perServingNutrients.kcalPer100g,
      matched: result.matchedCount,
      unmatched: result.unmatchedCount,
      sources: matchedIngredients.reduce<Record<string, number>>((counts, ingredient) => {
        const source = ingredient.nutritionSource ?? "unmatched"
        counts[source] = (counts[source] ?? 0) + 1
        return counts
      }, {}),
    },
    "Estimated nutrition for recipe",
  )

  return result
}

export function hasManualCalories(recipe: MealieRecipe): boolean {
  const hasHash = recipe.extras?.calorie_estimator_hash != null
  const hasStoredNutrition =
    recipe.nutrition?.calories != null && recipe.nutrition.calories.trim().length > 0

  return !hasHash && hasStoredNutrition
}

export function buildManualAckPatch(recipe: MealieRecipe, hash: string): NutritionPatch {
  return {
    nutrition: {},
    extras: {
      ...recipe.extras,
      calorie_estimator_hash: hash,
      calorie_estimator_unmatched: JSON.stringify([]),
      calorie_estimator_note: "Manual — preserved existing calorie entry",
    },
  }
}

function n(v: number | null): string {
  return v != null ? Math.round(v).toString() : ""
}

export function buildNutritionPatch(
  result: EstimateResult,
  hash: string,
  recipeYield: string | null,
): NutritionPatch {
  const llmIngredients = result.matchedIngredients
    .filter((i) => i.llmEstimated)
    .map((i) => i.name)

  const extras: Record<string, string> = {
    calorie_estimator_hash: hash,
    calorie_estimator_unmatched: JSON.stringify(result.unmatchedIngredients),
    calorie_estimator_provenance: JSON.stringify(
      result.matchedIngredients.map((ingredient) => ({
        name: ingredient.name,
        lookupQuery: ingredient.lookupQuery ?? null,
        grams: ingredient.grams,
        matched: ingredient.matched,
        nutritionSource: ingredient.nutritionSource ?? null,
        confidence: ingredient.confidence ?? null,
        productName: ingredient.productName ?? null,
        providerId: ingredient.providerId ?? null,
        matchScore: ingredient.matchScore ?? null,
        verificationReason: ingredient.verificationReason ?? null,
        verifiedBy: ingredient.verifiedBy ?? null,
        weightSource: ingredient.weightSource ?? null,
        llmAssisted:
          ingredient.llmEstimated === true
          || ingredient.nutritionSource === "llm"
          || ingredient.weightSource === "llm",
      })),
    ),
  }
  extras.calorie_estimator_low_confidence = JSON.stringify(
    result.matchedIngredients
      .filter((ingredient) => ingredient.confidence === "low")
      .map((ingredient) => ingredient.name),
  )

  if (llmIngredients.length > 0) {
    extras.calorie_estimator_llm_ingredients = JSON.stringify(llmIngredients)
    extras.calorie_estimator_llm_model = config.llm.model
  }

  const p = result.perServingNutrients
  const totalKcal = result.totalNutrients.kcalPer100g
  if (totalKcal !== null && totalKcal > 0) {
    extras.calorie_estimator_total_kcal = totalKcal.toString()
  }

  const servings = parseYield(recipeYield)
  if (servings !== null) {
    extras.calorie_estimator_yield = servings.toString()
  }

  const nutrition: Partial<MealieNutrition> = {}
  const add = (key: keyof MealieNutrition, val: string) => {
    if (val !== "") nutrition[key] = val
  }

  add("calories", n(p.kcalPer100g))
  add("proteinContent", n(p.proteinPer100g))
  add("carbohydrateContent", n(p.carbsPer100g))
  add("fatContent", n(p.fatPer100g))
  add("saturatedFatContent", n(p.saturatedFatPer100g))
  add("transFatContent", n(p.transFatPer100g))
  add("unsaturatedFatContent", n(p.unsaturatedFatPer100g))
  add("fiberContent", n(p.fiberPer100g))
  add("sugarContent", n(p.sugarPer100g))
  add("sodiumContent", n(p.sodiumPer100g))
  add("cholesterolContent", n(p.cholesterolPer100g))

  return { nutrition, extras }
}
