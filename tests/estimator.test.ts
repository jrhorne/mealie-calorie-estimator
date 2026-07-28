import { describe, it, expect } from "vitest"
import {
  buildManualAckPatch,
  buildNutritionPatch,
  computeIngredientHash,
  estimateRecipe,
  hasManualCalories,
  parseYield,
} from "../src/services/estimator.js"
import type { MealieRecipe, EstimateResult, NutrientSet } from "../src/types.js"

function makeRecipe(overrides: Partial<MealieRecipe> = {}): MealieRecipe {
  return {
    slug: "test-recipe",
    name: "Test Recipe",
    recipeYield: "4 servings",
    recipeServings: 4,
    recipeIngredient: [],
    nutrition: null,
    tags: [],
    extras: {},
    householdId: null,
    ...overrides,
  }
}

function n(kcal: number | null, p: Partial<NutrientSet> = {}): NutrientSet {
  return {
    kcalPer100g: kcal, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
    saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
    fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
    ...p,
  }
}

describe("computeIngredientHash", () => {
  it("produces consistent hash for same ingredients", () => {
    const a = makeRecipe({
      recipeIngredient: [
        {
          quantity: 2, unit: { id: "1", name: "cup", pluralName: "cups", abbreviation: "c", standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "flour", pluralName: null, aliases: [] },
          note: null, display: "2 cups flour", title: null, original_text: null,
        },
        {
          quantity: 1, unit: { id: "2", name: "tbsp", pluralName: "tbsp", abbreviation: "T", standardQuantity: null, standardUnit: null },
          food: { id: "2", name: "sugar", pluralName: null, aliases: [] },
          note: null, display: "1 tbsp sugar", title: null, original_text: null,
        },
      ],
    })

    const b = makeRecipe({
      recipeIngredient: [
        {
          quantity: 1, unit: { id: "2", name: "tbsp", pluralName: "tbsp", abbreviation: "T", standardQuantity: null, standardUnit: null },
          food: { id: "2", name: "sugar", pluralName: null, aliases: [] },
          note: null, display: "1 tbsp sugar", title: null, original_text: null,
        },
        {
          quantity: 2, unit: { id: "1", name: "cup", pluralName: "cups", abbreviation: "c", standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "flour", pluralName: null, aliases: [] },
          note: null, display: "2 cups flour", title: null, original_text: null,
        },
      ],
    })

    expect(computeIngredientHash(a)).toBe(computeIngredientHash(b))
  })

  it("produces different hash for different ingredients", () => {
    const a = makeRecipe({
      recipeIngredient: [
        {
          quantity: 2, unit: { id: "1", name: "cup", pluralName: "cups", abbreviation: "c", standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "flour", pluralName: null, aliases: [] },
          note: null, display: "2 cups flour", title: null, original_text: null,
        },
      ],
    })

    const b = makeRecipe({
      recipeIngredient: [
        {
          quantity: 3, unit: { id: "1", name: "cup", pluralName: "cups", abbreviation: "c", standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "flour", pluralName: null, aliases: [] },
          note: null, display: "3 cups flour", title: null, original_text: null,
        },
      ],
    })

    expect(computeIngredientHash(a)).not.toBe(computeIngredientHash(b))
  })

  it("handles empty ingredient list", () => {
    const recipe = makeRecipe({ recipeIngredient: [] })
    expect(computeIngredientHash(recipe)).toBeTruthy()
  })

  it("produces different hash when servings change but ingredients are the same", () => {
    const a = makeRecipe({ recipeYield: "4 servings", recipeServings: 4 })
    const b = makeRecipe({ recipeYield: "6 servings", recipeServings: 6 })

    expect(computeIngredientHash(a)).not.toBe(computeIngredientHash(b))
  })

  it("includes nutrition overrides in the ingredient hash", () => {
    const plain = makeRecipe()
    const overridden = makeRecipe({
      extras: {
        calorie_estimator_overrides: JSON.stringify({
          cream: { query: "heavy cream" },
        }),
      },
    })

    expect(computeIngredientHash(plain)).not.toBe(computeIngredientHash(overridden))
  })

  it("produces same hash when yield string differs but parsed servings are same", () => {
    const a = makeRecipe({ recipeYield: "4 servings", recipeServings: 4 })
    const b = makeRecipe({ recipeYield: "4 Portionen", recipeServings: 4 })

    expect(computeIngredientHash(a)).not.toBe(computeIngredientHash(b))
  })

  it("handles null fields", () => {
    const recipe = makeRecipe({
      recipeIngredient: [
        {
          quantity: null, unit: null, food: null,
          note: "salt to taste", display: "salt to taste", title: null, original_text: null,
        },
      ],
    })
    expect(computeIngredientHash(recipe)).toBeTruthy()
  })
})

describe("parseYield", () => {
  it.each([
    ["4 servings", 4],
    ["6 Portionen", 6],
    ["1 loaf", 1],
    ["6-8 portions", 7],
    ["4-6", 5],
    ["12", 12],
    ["2.5 cups", 2.5],
  ])("parses '%s' to %d", (input, expected) => {
    expect(parseYield(input)).toBe(expected)
  })

  it.each([
    [null, null],
    ["", null],
    ["as needed", null],
  ])("returns null for '%s'", (input, expected) => {
    expect(parseYield(input)).toBe(expected)
  })
})

describe("estimateRecipe", () => {
  it("calculates plausible sodium for one teaspoon of salt", async () => {
    const recipe = makeRecipe({
      recipeYield: "8 servings",
      recipeServings: 8,
      recipeIngredient: [
        {
          quantity: 1,
          unit: {
            id: "teaspoon",
            name: "teaspoon",
            pluralName: "teaspoons",
            abbreviation: "tsp",
            standardQuantity: null,
            standardUnit: null,
          },
          food: { id: "salt", name: "salt", pluralName: null, aliases: [] },
          note: null,
          display: "1 teaspoon salt",
          title: null,
          originalText: null,
        },
      ],
    })

    const result = await estimateRecipe(recipe)

    expect(result.matchedCount).toBe(1)
    expect(result.unmatchedCount).toBe(0)
    expect(result.totalNutrients.sodiumPer100g).toBeCloseTo(1937.9)
    expect(result.perServingNutrients.sodiumPer100g).toBeCloseTo(242.2375)
  })
})

describe("buildNutritionPatch", () => {
  it("builds patch with all nutrients per serving", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: 4,
      totalNutrients: n(1400, { proteinPer100g: 40, fatPer100g: 60 }),
      perServingNutrients: n(350, { proteinPer100g: 10, fatPer100g: 15 }),
      matchedCount: 5,
      unmatchedCount: 0,
      unmatchedIngredients: [],
      matchedIngredients: [],
    }

    const patch = buildNutritionPatch(result, "abc123", "4 servings")

    expect(patch.nutrition.calories).toBe("350")
    expect(patch.nutrition.proteinContent).toBe("10")
    expect(patch.nutrition.fatContent).toBe("15")
    expect(patch.extras.calorie_estimator_hash).toBe("abc123")
    expect(patch.extras.calorie_estimator_total_kcal).toBe("1400")
    expect(patch.extras.calorie_estimator_yield).toBe("4")
    expect(patch.extras.calorie_estimator_unmatched).toBe("[]")
  })

  it("builds patch with empty nutrition when no servings", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: null,
      totalNutrients: n(500),
      perServingNutrients: n(null),
      matchedCount: 2,
      unmatchedCount: 0,
      unmatchedIngredients: [],
      matchedIngredients: [],
    }

    const patch = buildNutritionPatch(result, "def456", null)

    expect(patch.nutrition.calories).toBeUndefined()
    expect(patch.extras.calorie_estimator_yield).toBeUndefined()
    expect(patch.extras.calorie_estimator_total_kcal).toBe("500")
  })

  it("stores ingredient-level source and confidence provenance", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: 1,
      totalNutrients: n(0, { sodiumPer100g: 1937.9 }),
      perServingNutrients: n(0, { sodiumPer100g: 1938 }),
      matchedCount: 1,
      unmatchedCount: 0,
      unmatchedIngredients: [],
      matchedIngredients: [
        {
          name: "salt",
          grams: 5,
          matched: true,
          nutrients: n(0, { sodiumPer100g: 38_758 }),
          nutritionSource: "known",
          confidence: "high",
          productName: "Known composition: table salt",
        },
      ],
    }

    const patch = buildNutritionPatch(result, "known-source", "1 serving")
    const provenance = JSON.parse(patch.extras.calorie_estimator_provenance)

    expect(provenance).toEqual([
      {
        name: "salt",
        lookupQuery: null,
        grams: 5,
        matched: true,
        nutritionSource: "known",
        confidence: "high",
        productName: "Known composition: table salt",
        providerId: null,
        matchScore: null,
        verificationReason: null,
        verifiedBy: null,
        weightSource: null,
        llmAssisted: false,
      },
    ])
    expect(patch.extras.calorie_estimator_low_confidence).toBe("[]")
  })

  it("handles zero total kcal", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: 4,
      totalNutrients: n(0),
      perServingNutrients: n(0),
      matchedCount: 0,
      unmatchedCount: 3,
      unmatchedIngredients: ["salt", "pepper", "herbs"],
      matchedIngredients: [],
    }

    const patch = buildNutritionPatch(result, "ghi789", "4 servings")

    expect(patch.nutrition.calories).toBe("0")
    expect(patch.extras.calorie_estimator_total_kcal).toBeUndefined()
    expect(patch.extras.calorie_estimator_unmatched).toBe(JSON.stringify(["salt", "pepper", "herbs"]))
  })
})

describe("hasManualCalories", () => {
  it("detects manual entry: no hash, has nutrition", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "400", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: {},
    })
    expect(hasManualCalories(recipe)).toBe(true)
  })

  it("returns false when hash already exists", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "400", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: { calorie_estimator_hash: "abc123" },
    })
    expect(hasManualCalories(recipe)).toBe(false)
  })

  it("returns false when nutrition.calories is empty", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: {},
    })
    expect(hasManualCalories(recipe)).toBe(false)
  })

  it("returns false when nutrition is null", () => {
    const recipe = makeRecipe({ nutrition: null, extras: {} })
    expect(hasManualCalories(recipe)).toBe(false)
  })
})

describe("buildManualAckPatch", () => {
  it("sets hash and note, leaves nutrition untouched", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "400", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: {},
    })
    const patch = buildManualAckPatch(recipe, "manual-hash")

    expect(patch.nutrition).toEqual({})
    expect(patch.extras.calorie_estimator_hash).toBe("manual-hash")
    expect(patch.extras.calorie_estimator_note).toBe("Manual — preserved existing calorie entry")
  })
})
