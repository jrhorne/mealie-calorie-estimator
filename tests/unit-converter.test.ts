import { describe, it, expect } from "vitest"
import { convertToGrams } from "../src/services/unit-converter.js"
import type { MealieUnit } from "../src/types.js"

function unit(overrides: Partial<MealieUnit> = {}): MealieUnit {
  return {
    id: "1",
    name: "g",
    pluralName: "g",
    abbreviation: "g",
    standardQuantity: null,
    standardUnit: null,
    ...overrides,
  }
}

describe("convertToGrams", () => {
  it("does not assume milliliters have water density", () => {
    const u = unit({ name: "cup", standardQuantity: 240, standardUnit: "ml" })
    expect(convertToGrams(2, u)).toBeNull()
  })

  it("uses standardQuantity with g unit", () => {
    const u = unit({ name: "custom", standardQuantity: 100, standardUnit: "g" })
    expect(convertToGrams(3, u)).toBe(300)
  })

  it("uses fallback for known units", () => {
    expect(convertToGrams(1, unit({ name: "kg" }))).toBe(1000)
    expect(convertToGrams(1, unit({ name: "oz" }))).toBe(28.35)
    expect(convertToGrams(1, unit({ name: "lb" }))).toBe(453.592)
    expect(convertToGrams(1, unit({ name: "pinch" }))).toBe(0.5)
  })

  it("requires ingredient-specific weights for volume measures", () => {
    expect(convertToGrams(1, unit({ name: "cup" }))).toBeNull()
    expect(convertToGrams(2, unit({ name: "tbsp" }))).toBeNull()
    expect(convertToGrams(3, unit({ name: "tsp" }))).toBeNull()
    expect(convertToGrams(100, unit({ name: "ml" }))).toBeNull()
  })

  it("uses the deterministic known composition weight for culinary salt", () => {
    expect(convertToGrams(1, unit({ name: "tsp" }), "salt")).toBe(5)
    expect(convertToGrams(2, unit({ name: "tbsp" }), "kosher salt")).toBe(30)
  })

  it("returns null for unknown units", () => {
    expect(convertToGrams(1, unit({ name: "handful", abbreviation: "" }))).toBeNull()
  })

  it("returns null for piece/slice units", () => {
    expect(convertToGrams(2, unit({ name: "piece" }))).toBeNull()
    expect(convertToGrams(1, unit({ name: "slice" }))).toBeNull()
  })

  it("returns null when unit is null", () => {
    expect(convertToGrams(1, null)).toBeNull()
  })

  it("does not convert liters to grams without ingredient density", () => {
    const u = unit({ name: "liter", standardQuantity: 1, standardUnit: "l" })
    expect(convertToGrams(2, u)).toBeNull()
  })
})
