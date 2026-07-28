const COMPOSITE_FOOD_TOKENS = new Set([
  "bagel",
  "bread",
  "burger",
  "cake",
  "casserole",
  "cookie",
  "cracker",
  "dressing",
  "meal",
  "pizza",
  "sandwich",
  "sauce",
  "soup",
  "steak",
])

const DESCRIPTOR_TOKENS = new Set([
  "canned",
  "chopped",
  "cooked",
  "diced",
  "dried",
  "fresh",
  "frozen",
  "ground",
  "light",
  "raw",
  "red",
  "sweet",
  "whole",
  "yellow",
])

function singularize(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`
  if (token.endsWith("oes") && token.length > 4) return token.slice(0, -2)
  if (token.endsWith("ses") && token.length > 4) return token.slice(0, -2)
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1)
  }
  return token
}

export function normalizedFoodTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(singularize)
    .filter((token) => token.length >= 2)
}

function meaningfulHead(tokens: string[]): string | null {
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (!DESCRIPTOR_TOKENS.has(tokens[index])) return tokens[index]
  }
  return tokens.at(-1) ?? null
}

export function scoreFoodMatch(
  query: string,
  candidate: string,
  dataType?: string,
): number {
  const queryTokens = [...new Set(normalizedFoodTokens(query))]
  const candidateTokens = [...new Set(normalizedFoodTokens(candidate))]
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0

  const candidateSet = new Set(candidateTokens)
  const querySet = new Set(queryTokens)
  const overlap = queryTokens.filter((token) => candidateSet.has(token)).length
  if (overlap === 0) return 0

  const coverage = overlap / queryTokens.length
  const precision = overlap / candidateTokens.length
  const head = meaningfulHead(queryTokens)
  const headPresent = head !== null && candidateSet.has(head)
  const normalizedQuery = queryTokens.join(" ")
  const normalizedCandidate = candidateTokens.join(" ")

  let score = coverage * 0.65 + precision * 0.15
  if (normalizedQuery === normalizedCandidate) score += 0.2
  score += headPresent ? 0.15 : -0.35

  const hasUnexpectedComposite = candidateTokens.some(
    (token) => COMPOSITE_FOOD_TOKENS.has(token) && !querySet.has(token),
  )
  if (hasUnexpectedComposite) score -= 0.35

  const normalizedDataType = dataType?.toLowerCase() ?? ""
  if (normalizedDataType.includes("foundation") || normalizedDataType.includes("sr legacy")) {
    score += 0.1
  } else if (normalizedDataType.includes("survey") || normalizedDataType.includes("fndds")) {
    score -= 0.1
  }

  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000))
}

export function foodMatchIsPlausible(score: number): boolean {
  return score >= 0.45
}
