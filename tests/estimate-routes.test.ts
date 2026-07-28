import Fastify from "fastify"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EstimateResult, MealieRecipe, NutrientSet } from "../src/types.js"

const {
  applyEstimateAndTagMock,
  estimateAndTagMock,
  estimateRecipeMock,
  getRecipeMock,
} = vi.hoisted(() => ({
  applyEstimateAndTagMock: vi.fn(),
  estimateAndTagMock: vi.fn(),
  estimateRecipeMock: vi.fn(),
  getRecipeMock: vi.fn(),
}))

vi.mock("../src/services/mealie-client.js", () => ({
  getRecipe: getRecipeMock,
  getRecipeHouseholdId: vi.fn(() => null),
}))

vi.mock("../src/services/estimator.js", () => ({
  computeIngredientHash: vi.fn(() => "hash"),
  estimateRecipe: estimateRecipeMock,
  shouldEstimate: vi.fn(() => true),
}))

vi.mock("../src/services/tagging.js", () => ({
  applyEstimateAndTag: applyEstimateAndTagMock,
  estimateAndTag: estimateAndTagMock,
}))

import { estimateRoutes } from "../src/routes/estimate.js"

function empty(): NutrientSet {
  return {
    kcalPer100g: null, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
    saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
    fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null,
    cholesterolPer100g: null,
  }
}

const recipe: MealieRecipe = {
  slug: "preview-test",
  name: "Preview Test",
  recipeYield: "2 servings",
  recipeServings: 2,
  recipeIngredient: [],
  nutrition: null,
  tags: [],
  extras: {},
}

const result: EstimateResult = {
  slug: recipe.slug,
  servings: 2,
  totalNutrients: { ...empty(), kcalPer100g: 400 },
  perServingNutrients: { ...empty(), kcalPer100g: 200 },
  matchedCount: 0,
  unmatchedCount: 0,
  unmatchedIngredients: [],
  matchedIngredients: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  getRecipeMock.mockResolvedValue(recipe)
  estimateRecipeMock.mockResolvedValue(result)
  applyEstimateAndTagMock.mockResolvedValue({
    calories: 200,
    tagSlugs: ["calories-light"],
  })
})

describe("estimate routes", () => {
  it("previews synchronously without applying a Mealie patch", async () => {
    const app = Fastify()
    await app.register(estimateRoutes)

    const response = await app.inject({
      method: "POST",
      url: "/estimate/preview",
      payload: { slug: recipe.slug },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: "preview",
      result: { slug: recipe.slug },
    })
    expect(applyEstimateAndTagMock).not.toHaveBeenCalled()
    expect(estimateAndTagMock).not.toHaveBeenCalled()
    await app.close()
  })

  it("applies exactly the estimate that was calculated", async () => {
    const app = Fastify()
    await app.register(estimateRoutes)

    const response = await app.inject({
      method: "POST",
      url: "/estimate/apply",
      payload: { slug: recipe.slug },
    })

    expect(response.statusCode).toBe(200)
    expect(applyEstimateAndTagMock).toHaveBeenCalledTimes(1)
    expect(applyEstimateAndTagMock).toHaveBeenCalledWith(recipe, result, "hash", null)
    await app.close()
  })
})
