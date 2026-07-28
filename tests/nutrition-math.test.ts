import { describe, expect, it } from "vitest"
import {
  addScaledNutrients,
  divideNutrients,
  emptyNutrients,
} from "../src/services/nutrition-math.js"
import type { NutrientSet } from "../src/types.js"

function nutrients(kcal: number, sodium: number): NutrientSet {
  return {
    ...emptyNutrients(),
    kcalPer100g: kcal,
    sodiumPer100g: sodium,
  }
}

describe("deterministic nutrition math", () => {
  it("scales, sums, and divides only in application code", () => {
    let total = emptyNutrients()
    total = addScaledNutrients(total, nutrients(123.45, 67.89), 37.5)
    total = addScaledNutrients(total, nutrients(50.25, 10.5), 12.25)

    expect(total.kcalPer100g).toBe(52.449375)
    expect(total.sodiumPer100g).toBe(26.745)
    expect(divideNutrients(total, 3).kcalPer100g).toBe(17.483125)
  })

  it("preserves zero-calorie nutrient values", () => {
    const total = addScaledNutrients(
      emptyNutrients(),
      nutrients(0, 38_758),
      5,
    )

    expect(total.kcalPer100g).toBe(0)
    expect(total.sodiumPer100g).toBe(1937.9)
  })
})
