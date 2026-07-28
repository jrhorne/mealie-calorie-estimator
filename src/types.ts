export interface MealieIngredient {
  quantity: number | null
  unit: MealieUnit | null
  food: MealieFood | null
  note: string | null
  display: string
  title: string | null
  originalText: string | null
  referenceId?: string | null
}

export interface MealieUnit {
  id: string
  name: string
  pluralName: string | null
  abbreviation: string | null
  standardQuantity: number | null
  standardUnit: string | null
}

export interface MealieFood {
  id: string
  name: string
  pluralName: string | null
  aliases: string[]
}

export interface MealieNutrition {
  calories: string | null
  carbohydrateContent: string | null
  cholesterolContent: string | null
  fatContent: string | null
  fiberContent: string | null
  proteinContent: string | null
  saturatedFatContent: string | null
  sodiumContent: string | null
  sugarContent: string | null
  transFatContent: string | null
  unsaturatedFatContent: string | null
}

export interface MealieTag {
  id: string
  name: string
  slug: string
  groupId: string | null
}

export interface MealieRecipe {
  slug: string
  name: string
  recipeYield: string | null
  recipeServings: number | null
  recipeIngredient: MealieIngredient[]
  nutrition: MealieNutrition | null
  tags: MealieTag[] | null
  extras: Record<string, string> | null
  householdId?: string | null
  household_id?: string | null
}

export interface MealieRecipePatch {
  nutrition?: Partial<MealieNutrition>
  extras?: Record<string, string>
  tags?: MealieTag[]
}

export interface OffSearchResult {
  hits: OffProduct[]
  count?: number
  page?: number
  page_count?: number
  page_size?: number
}

export interface OffProduct {
  code?: string
  product_name: string
  nutriments?: OffNutriments
  nutriscore_grade?: string
}

export interface OffNutriments {
  "energy-kcal_100g": number | null
  "proteins_100g": number | null
  "carbohydrates_100g": number | null
  "fat_100g": number | null
  "saturated-fat_100g": number | null
  "trans-fat_100g": number | null
  "fiber_100g": number | null
  "sugars_100g": number | null
  "sodium_100g": number | null
  "cholesterol_100g": number | null
}

export interface AppriseWebhookPayload {
  title: string
  body: string
  event_type: string
  document_data?: string
  event_id?: string
  timestamp?: string
}

export interface EventRecipeData {
  document_type: string
  documentType?: string
  operation: string
  recipe_slug: string
  recipeSlug?: string
}

export interface NutrientSet {
  kcalPer100g: number | null
  proteinPer100g: number | null
  carbsPer100g: number | null
  fatPer100g: number | null
  saturatedFatPer100g: number | null
  transFatPer100g: number | null
  unsaturatedFatPer100g: number | null
  fiberPer100g: number | null
  sugarPer100g: number | null
  sodiumPer100g: number | null
  cholesterolPer100g: number | null
}

export type NutritionSource = "known" | "openfoodfacts" | "usda" | "llm"
export type NutritionConfidence = "high" | "medium" | "low"

export interface NutritionCandidate {
  id: string
  nutrients: NutrientSet
  productName: string
  source: Exclude<NutritionSource, "llm">
  matchScore: number
  dataType?: string
}

export interface NutritionCandidateGroup {
  ingredient: string
  lookupQuery?: string
  candidates: NutritionCandidate[]
}

export interface NutritionCandidateDecision {
  ingredient: string
  candidateId: string | null
  confidence: NutritionConfidence
  reason: string
  verifiedBy: "llm" | "deterministic" | "cache"
}

export interface NutritionLookupResult {
  nutrients: NutrientSet | null
  matched: boolean
  productName: string | null
  source: Exclude<NutritionSource, "llm">
  providerId?: string
  matchScore?: number
  confidence?: NutritionConfidence
  dataType?: string
}

export interface IngredientMatch {
  name: string
  lookupQuery?: string | null
  grams: number | null
  matched: boolean
  nutrients: NutrientSet | null
  llmEstimated?: boolean
  nutritionSource?: NutritionSource
  confidence?: NutritionConfidence
  productName?: string | null
  providerId?: string | null
  matchScore?: number | null
  verificationReason?: string | null
  verifiedBy?: NutritionCandidateDecision["verifiedBy"] | null
  weightSource?: "unit-converter" | "llm" | "override"
}

export interface NutritionOverride {
  query?: string
  grams?: number
}

export interface EstimateResult {
  slug: string
  servings: number | null
  totalNutrients: NutrientSet
  perServingNutrients: NutrientSet
  matchedCount: number
  unmatchedCount: number
  unmatchedIngredients: string[]
  matchedIngredients: IngredientMatch[]
}

export interface NutritionPatch {
  nutrition: Partial<MealieNutrition>
  extras: Record<string, string>
}
