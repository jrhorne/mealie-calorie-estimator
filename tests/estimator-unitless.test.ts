import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MealieRecipe, NutrientSet } from "../src/types.js"

const {
  estimateGramsMock,
  estimateNutrientsMock,
  lookupOffCandidatesMock,
  lookupUsdaCandidatesMock,
  verifyNutritionCandidatesMock,
} = vi.hoisted(() => ({
  estimateGramsMock: vi.fn(),
  estimateNutrientsMock: vi.fn(),
  lookupOffCandidatesMock: vi.fn(),
  lookupUsdaCandidatesMock: vi.fn(),
  verifyNutritionCandidatesMock: vi.fn(),
}))

vi.mock("../src/services/unit-converter.js", () => ({
  convertToGrams: vi.fn(() => null),
}))

vi.mock("../src/services/off-client.js", () => ({
  lookupOffCandidates: lookupOffCandidatesMock,
}))

vi.mock("../src/services/usda-client.js", () => ({
  lookupUsdaCandidates: lookupUsdaCandidatesMock,
}))

vi.mock("../src/services/llm-estimator.js", () => ({
  estimateGrams: estimateGramsMock,
  estimateNutrients: estimateNutrientsMock,
  verifyNutritionCandidates: verifyNutritionCandidatesMock,
}))

import { estimateRecipe } from "../src/services/estimator.js"

const nutrients: NutrientSet = {
  kcalPer100g: 31,
  proteinPer100g: 1,
  carbsPer100g: 6,
  fatPer100g: 0.3,
  saturatedFatPer100g: 0,
  transFatPer100g: 0,
  unsaturatedFatPer100g: 0.3,
  fiberPer100g: 2,
  sugarPer100g: 4,
  sodiumPer100g: 4,
  cholesterolPer100g: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  estimateGramsMock.mockResolvedValue(360)
  estimateNutrientsMock.mockResolvedValue(null)
  lookupOffCandidatesMock.mockResolvedValue([{
    id: "openfoodfacts:peppers",
    nutrients,
    productName: "Peppers",
    source: "openfoodfacts",
    matchScore: 1,
  }])
  lookupUsdaCandidatesMock.mockResolvedValue([])
  verifyNutritionCandidatesMock.mockResolvedValue(new Map([
    ["peppers", {
      ingredient: "peppers",
      candidateId: "openfoodfacts:peppers",
      confidence: "high",
      reason: "Exact match",
      verifiedBy: "llm",
    }],
  ]))
})

describe("estimateRecipe unitless counts", () => {
  it("uses the LLM item-weight fallback when Mealie parsed a count without a unit", async () => {
    const recipe: MealieRecipe = {
      slug: "pepper-test",
      name: "Pepper Test",
      recipeYield: "3 servings",
      recipeServings: 3,
      nutrition: null,
      tags: [],
      extras: {},
      recipeIngredient: [{
        quantity: 3,
        unit: null,
        food: { id: "food-1", name: "peppers", pluralName: null, aliases: [] },
        note: "diced",
        display: "3 peppers, diced",
        title: null,
        originalText: "3 peppers, diced",
      }],
    }

    const result = await estimateRecipe(recipe)

    expect(estimateGramsMock).toHaveBeenCalledWith(3, "item", "peppers")
    expect(result.matchedCount).toBe(1)
    expect(result.unmatchedCount).toBe(0)
    expect(result.totalNutrients.kcalPer100g).toBeCloseTo(111.6)
    expect(result.matchedIngredients[0].llmEstimated).toBe(true)
    expect(result.matchedIngredients[0].confidence).toBe("low")
  })

  it("uses a manual canonical query and total gram override without LLM weight math", async () => {
    const recipe: MealieRecipe = {
      slug: "pepper-override-test",
      name: "Pepper Override Test",
      recipeYield: "3 servings",
      recipeServings: 3,
      nutrition: null,
      tags: [],
      extras: {
        calorie_estimator_overrides: JSON.stringify({
          peppers: { query: "bell peppers", grams: 360 },
        }),
      },
      recipeIngredient: [{
        quantity: 3,
        unit: null,
        food: { id: "food-1", name: "peppers", pluralName: null, aliases: [] },
        note: "diced",
        display: "3 peppers, diced",
        title: null,
        originalText: "3 peppers, diced",
      }],
    }

    const result = await estimateRecipe(recipe)

    expect(estimateGramsMock).not.toHaveBeenCalled()
    expect(lookupOffCandidatesMock).toHaveBeenCalledWith("bell peppers", undefined)
    expect(result.matchedIngredients[0]).toMatchObject({
      name: "peppers",
      lookupQuery: "bell peppers",
      grams: 360,
      weightSource: "override",
    })
  })
})
