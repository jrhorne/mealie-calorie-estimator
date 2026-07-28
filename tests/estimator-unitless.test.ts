import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MealieRecipe, NutrientSet } from "../src/types.js"

const {
  estimateGramsMock,
  estimateNutrientsMock,
  lookupOffCandidateByIdMock,
  lookupOffCandidatesMock,
  lookupUsdaCandidateByIdMock,
  lookupUsdaCandidatesMock,
  verifyNutritionCandidatesMock,
} = vi.hoisted(() => ({
  estimateGramsMock: vi.fn(),
  estimateNutrientsMock: vi.fn(),
  lookupOffCandidateByIdMock: vi.fn(),
  lookupOffCandidatesMock: vi.fn(),
  lookupUsdaCandidateByIdMock: vi.fn(),
  lookupUsdaCandidatesMock: vi.fn(),
  verifyNutritionCandidatesMock: vi.fn(),
}))

vi.mock("../src/services/unit-converter.js", () => ({
  convertToGrams: vi.fn(() => null),
}))

vi.mock("../src/services/off-client.js", () => ({
  lookupOffCandidateById: lookupOffCandidateByIdMock,
  lookupOffCandidates: lookupOffCandidatesMock,
}))

vi.mock("../src/services/usda-client.js", () => ({
  lookupUsdaCandidateById: lookupUsdaCandidateByIdMock,
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
  lookupOffCandidateByIdMock.mockResolvedValue(null)
  lookupUsdaCandidatesMock.mockResolvedValue([])
  lookupUsdaCandidateByIdMock.mockResolvedValue(null)
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

  it("uses an exact manual provider override without asking the LLM to arbitrate", async () => {
    lookupOffCandidatesMock.mockResolvedValue([
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `openfoodfacts:prepared-${index}`,
        nutrients: { ...nutrients, kcalPer100g: 70 },
        productName: `Whole Wheat Rotini, prepared ${index}`,
        source: "openfoodfacts",
        matchScore: 1,
      })),
    ])
    lookupUsdaCandidatesMock.mockResolvedValue([
      {
        id: "usda:dry",
        nutrients: { ...nutrients, kcalPer100g: 352 },
        productName: "Pasta, whole-wheat, dry",
        source: "usda",
        matchScore: 0.96,
      },
    ])
    verifyNutritionCandidatesMock.mockResolvedValue(new Map())
    const recipe: MealieRecipe = {
      slug: "rotini-provider-override-test",
      name: "Rotini Provider Override Test",
      recipeYield: "8 servings",
      recipeServings: 8,
      nutrition: null,
      tags: [],
      extras: {
        calorie_estimator_overrides: JSON.stringify({
          rotini: {
            query: "dry whole-wheat pasta",
            grams: 454,
            providerId: "usda:dry",
          },
        }),
      },
      recipeIngredient: [{
        quantity: 1,
        unit: null,
        food: { id: "food-2", name: "rotini", pluralName: null, aliases: [] },
        note: null,
        display: "1 box rotini",
        title: null,
        originalText: "1 box rotini",
      }],
    }

    const result = await estimateRecipe(recipe)

    expect(verifyNutritionCandidatesMock).toHaveBeenCalledWith([])
    expect(result.totalNutrients.kcalPer100g).toBeCloseTo(1598.08)
    expect(result.matchedIngredients[0]).toMatchObject({
      providerId: "usda:dry",
      productName: "Pasta, whole-wheat, dry",
      verifiedBy: "override",
      confidence: "high",
    })
  })

  it("fails closed when a manual provider ID is not in the structured candidates", async () => {
    const recipe: MealieRecipe = {
      slug: "missing-provider-override-test",
      name: "Missing Provider Override Test",
      recipeYield: "3 servings",
      recipeServings: 3,
      nutrition: null,
      tags: [],
      extras: {
        calorie_estimator_overrides: JSON.stringify({
          peppers: { grams: 360, providerId: "usda:not-returned" },
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

    expect(estimateNutrientsMock).not.toHaveBeenCalled()
    expect(result.matchedCount).toBe(0)
    expect(result.unmatchedIngredients).toEqual(["peppers"])
    expect(result.matchedIngredients[0]).toMatchObject({
      matched: false,
      verifiedBy: "override",
      verificationReason: "Manual provider override was not found in current candidates",
    })
  })
})
