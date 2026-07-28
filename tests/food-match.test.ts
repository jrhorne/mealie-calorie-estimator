import { describe, expect, it } from "vitest"
import { foodMatchIsPlausible, scoreFoodMatch } from "../src/utils/food-match.js"

describe("scoreFoodMatch", () => {
  it.each([
    ["Italian seasoning", "Bread, Italian", "Survey (FNDDS)"],
    ["peppers", "Pepper steak", "Survey (FNDDS)"],
    ["whole-wheat rotini", "Bagel, whole wheat", "Survey (FNDDS)"],
  ])("rejects unrelated composite match %s -> %s", (query, candidate, dataType) => {
    expect(foodMatchIsPlausible(scoreFoodMatch(query, candidate, dataType))).toBe(false)
  })

  it.each([
    ["Italian seasoning", "Italian seasoning, dried herbs", "Foundation"],
    ["peppers", "Peppers, sweet, red, raw", "Foundation"],
    ["whole-wheat rotini", "Pasta, whole-wheat, rotini, dry", "Foundation"],
    ["yellow onion", "Onions, yellow, raw", "Foundation"],
    ["cream", "Cream, fluid, light", "Foundation"],
  ])("accepts plausible generic match %s -> %s", (query, candidate, dataType) => {
    expect(foodMatchIsPlausible(scoreFoodMatch(query, candidate, dataType))).toBe(true)
  })
})
