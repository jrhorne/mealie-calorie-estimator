import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { config } from "../src/config.js"
import { lookupUsdaNutrients } from "../src/services/usda-client.js"
import { initCache } from "../src/utils/cache.js"

const originalApiKey = config.usda.apiKey

beforeAll(async () => {
  await initCache()
  config.usda.maxRetries = 0
  config.usda.apiKey = "test-usda-key"
})

beforeEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  config.usda.apiKey = originalApiKey
})

describe("lookupUsdaNutrients", () => {
  it("maps FoodData Central nutrients into canonical grams and milligrams", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          foods: [
            {
              fdcId: 123,
              description: "APPLE, RAW",
              dataType: "Foundation",
              foodNutrients: [
                { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 52 },
                { nutrientId: 1003, nutrientName: "Protein", unitName: "G", value: 0.3 },
                { nutrientId: 1005, nutrientName: "Carbohydrate, by difference", unitName: "G", value: 13.8 },
                { nutrientId: 1004, nutrientName: "Total lipid (fat)", unitName: "G", value: 0.2 },
                { nutrientId: 1093, nutrientName: "Sodium, Na", unitName: "G", value: 0.001 },
                { nutrientId: 1253, nutrientName: "Cholesterol", unitName: "MG", value: 0 },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    const result = await lookupUsdaNutrients("raw apple provider test")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      matched: true,
      productName: "APPLE, RAW",
      source: "usda",
    })
    expect(result.nutrients).toMatchObject({
      kcalPer100g: 52,
      proteinPer100g: 0.3,
      sodiumPer100g: 1,
      cholesterolPer100g: 0,
    })
  })

  it("stays disabled and makes no request without an API key", async () => {
    config.usda.apiKey = ""
    const fetchMock = vi.spyOn(globalThis, "fetch")

    const result = await lookupUsdaNutrients("disabled provider test")

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      nutrients: null,
      matched: false,
      productName: null,
      source: "usda",
    })
    config.usda.apiKey = "test-usda-key"
  })
})
