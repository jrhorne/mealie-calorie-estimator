import crypto from "node:crypto"
import type {
  MealieRecipe, IngredientMatch, EstimateResult, NutritionPatch,
  NutrientSet, MealieNutrition, NutritionCandidate,
} from "../types.js"
import { config } from "../config.js"
import { convertToGrams } from "./unit-converter.js"
import { lookupOffCandidates } from "./off-client.js"
import { lookupUsdaCandidates } from "./usda-client.js"
import {
  estimateGrams,
  estimateNutrients,
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
  const hash = crypto.createHash("sha256").update(parts.join(",")).digest("hex")
  return hash
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
    grams: number | null
    weightSource: "unit-converter" | "llm"
    candidates: NutritionCandidate[]
  }

  const matchedIngredients: IngredientMatch[] = []
  const unmatchedNames: string[] = []
  let totalNutrients = emptyNutrients()
  const preparedIngredients: PreparedIngredient[] = []

  for (const ing of recipe.recipeIngredient) {
    const foodName = ing.food?.name
    const quantity = ing.quantity

    if (!foodName || quantity == null || quantity <= 0) {
      continue
    }

    let grams = convertToGrams(quantity, ing.unit)
    let weightSource: PreparedIngredient["weightSource"] = "unit-converter"

    if (grams === null) {
      const unitName = ing.unit?.name ?? "item"
      const llmGrams = await estimateGrams(quantity, unitName, foodName)
      if (llmGrams !== null) {
        grams = llmGrams
        weightSource = "llm"
      }
    }

    if (grams === null) {
      preparedIngredients.push({ name: foodName, grams: null, weightSource, candidates: [] })
      continue
    }

    const offCandidates = await lookupOffCandidates(foodName, ing.unit?.name)
    const candidates = offCandidates.some((candidate) => candidate.source === "known")
      ? offCandidates
      : [
          ...offCandidates,
          ...await lookupUsdaCandidates(foodName),
        ].sort((left, right) => right.matchScore - left.matchScore).slice(0, 5)
    preparedIngredients.push({ name: foodName, grams, weightSource, candidates })
  }

  const decisions = await verifyNutritionCandidates(
    preparedIngredients
      .filter((ingredient) => ingredient.grams !== null)
      .map((ingredient) => ({
        ingredient: ingredient.name,
        candidates: ingredient.candidates,
      })),
  )

  for (const ingredient of preparedIngredients) {
    const { name: foodName, grams, weightSource, candidates } = ingredient
    if (grams === null) {
      unmatchedNames.push(foodName)
      matchedIngredients.push({
        name: foodName,
        grams: null,
        matched: false,
        nutrients: null,
        confidence: "low",
        weightSource,
      })
      continue
    }

    const decision = decisions.get(foodName)
    const candidate = decision?.candidateId
      ? candidates.find((item) => item.id === decision.candidateId)
      : undefined

    if (!candidate) {
      const llmNutrients = await estimateNutrients(foodName)
      if (llmNutrients !== null) {
        totalNutrients = addScaledNutrients(totalNutrients, llmNutrients, grams)
        matchedIngredients.push({
          name: foodName,
          grams,
          matched: true,
          nutrients: llmNutrients,
          llmEstimated: true,
          nutritionSource: "llm",
          confidence: "low",
          verificationReason: decision?.reason ?? "No structured-source match",
          verifiedBy: decision?.verifiedBy ?? "deterministic",
          weightSource,
        })
        continue
      }
      unmatchedNames.push(foodName)
      matchedIngredients.push({
        name: foodName,
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
