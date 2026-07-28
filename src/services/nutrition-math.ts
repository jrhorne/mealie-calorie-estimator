import type { NutrientSet } from "../types.js"

const SCALE = 1_000_000n

function scaled(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid non-negative nutrient value: ${value}`)
  }
  return BigInt(Math.round(value * Number(SCALE)))
}

function numberFromScaled(value: bigint): number {
  return Number(value) / Number(SCALE)
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Division denominator must be positive")
  return (numerator + denominator / 2n) / denominator
}

function scaleValue(value: number | null, grams: number): number | null {
  if (value === null) return null
  const numerator = scaled(value) * scaled(grams)
  return numberFromScaled(roundedDivide(numerator, 100n * SCALE))
}

function addValue(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null
  return numberFromScaled(scaled(left ?? 0) + scaled(right ?? 0))
}

function divideValue(value: number | null, servings: number): number | null {
  if (value === null) return null
  return numberFromScaled(roundedDivide(scaled(value) * SCALE, scaled(servings)))
}

export function emptyNutrients(): NutrientSet {
  return {
    kcalPer100g: null,
    proteinPer100g: null,
    carbsPer100g: null,
    fatPer100g: null,
    saturatedFatPer100g: null,
    transFatPer100g: null,
    unsaturatedFatPer100g: null,
    fiberPer100g: null,
    sugarPer100g: null,
    sodiumPer100g: null,
    cholesterolPer100g: null,
  }
}

export function scaleNutrients(nutrients: NutrientSet, grams: number): NutrientSet {
  return {
    kcalPer100g: scaleValue(nutrients.kcalPer100g, grams),
    proteinPer100g: scaleValue(nutrients.proteinPer100g, grams),
    carbsPer100g: scaleValue(nutrients.carbsPer100g, grams),
    fatPer100g: scaleValue(nutrients.fatPer100g, grams),
    saturatedFatPer100g: scaleValue(nutrients.saturatedFatPer100g, grams),
    transFatPer100g: scaleValue(nutrients.transFatPer100g, grams),
    unsaturatedFatPer100g: scaleValue(nutrients.unsaturatedFatPer100g, grams),
    fiberPer100g: scaleValue(nutrients.fiberPer100g, grams),
    sugarPer100g: scaleValue(nutrients.sugarPer100g, grams),
    sodiumPer100g: scaleValue(nutrients.sodiumPer100g, grams),
    cholesterolPer100g: scaleValue(nutrients.cholesterolPer100g, grams),
  }
}

export function addNutrients(left: NutrientSet, right: NutrientSet): NutrientSet {
  return {
    kcalPer100g: addValue(left.kcalPer100g, right.kcalPer100g),
    proteinPer100g: addValue(left.proteinPer100g, right.proteinPer100g),
    carbsPer100g: addValue(left.carbsPer100g, right.carbsPer100g),
    fatPer100g: addValue(left.fatPer100g, right.fatPer100g),
    saturatedFatPer100g: addValue(left.saturatedFatPer100g, right.saturatedFatPer100g),
    transFatPer100g: addValue(left.transFatPer100g, right.transFatPer100g),
    unsaturatedFatPer100g: addValue(left.unsaturatedFatPer100g, right.unsaturatedFatPer100g),
    fiberPer100g: addValue(left.fiberPer100g, right.fiberPer100g),
    sugarPer100g: addValue(left.sugarPer100g, right.sugarPer100g),
    sodiumPer100g: addValue(left.sodiumPer100g, right.sodiumPer100g),
    cholesterolPer100g: addValue(left.cholesterolPer100g, right.cholesterolPer100g),
  }
}

export function addScaledNutrients(
  total: NutrientSet,
  nutrients: NutrientSet,
  grams: number,
): NutrientSet {
  return addNutrients(total, scaleNutrients(nutrients, grams))
}

export function divideNutrients(total: NutrientSet, servings: number): NutrientSet {
  if (!Number.isFinite(servings) || servings <= 0) {
    throw new Error(`Invalid serving count: ${servings}`)
  }
  return {
    kcalPer100g: divideValue(total.kcalPer100g, servings),
    proteinPer100g: divideValue(total.proteinPer100g, servings),
    carbsPer100g: divideValue(total.carbsPer100g, servings),
    fatPer100g: divideValue(total.fatPer100g, servings),
    saturatedFatPer100g: divideValue(total.saturatedFatPer100g, servings),
    transFatPer100g: divideValue(total.transFatPer100g, servings),
    unsaturatedFatPer100g: divideValue(total.unsaturatedFatPer100g, servings),
    fiberPer100g: divideValue(total.fiberPer100g, servings),
    sugarPer100g: divideValue(total.sugarPer100g, servings),
    sodiumPer100g: divideValue(total.sodiumPer100g, servings),
    cholesterolPer100g: divideValue(total.cholesterolPer100g, servings),
  }
}
