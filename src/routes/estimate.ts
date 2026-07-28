import type { FastifyInstance } from "fastify"
import { getRecipe, getRecipeHouseholdId } from "../services/mealie-client.js"
import {
  computeIngredientHash,
  estimateRecipe,
  shouldEstimate,
} from "../services/estimator.js"
import {
  applyEstimateAndTag,
  estimateAndTag,
} from "../services/tagging.js"
import { runRecipeJob } from "../utils/in-flight.js"
import { logger } from "../utils/logger.js"

async function processEstimate(slug: string): Promise<void> {
  try {
    logger.info({ slug }, "On-demand estimation processing")

    const recipe = await getRecipe(slug)

    if (!shouldEstimate(recipe)) {
      logger.info({ slug }, "Recipe skipped (not tagged for estimation)")
      return
    }

    const householdId = getRecipeHouseholdId(recipe)
    const hash = computeIngredientHash(recipe)
    const { calories, tagSlugs } = await estimateAndTag(recipe, hash, householdId)

    logger.info({ slug, calories, tags: tagSlugs }, "On-demand estimation complete")
  } catch (err) {
    logger.error({ slug, err }, "Estimate background processing failed")
  }
}

interface EstimateRequest {
  slug?: string
  content?: {
    slug?: string
  }
}

function requestSlug(body: EstimateRequest | undefined): string | null {
  const slug = body?.slug ?? body?.content?.slug
  return typeof slug === "string" && slug.trim() ? slug.trim() : null
}

export async function estimateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: EstimateRequest }>("/estimate", async (req, reply) => {
    const slug = requestSlug(req.body)
    if (!slug) return reply.status(400).send({ error: "Missing slug" })

    logger.info({ slug }, "On-demand estimation requested")

    reply.status(202).send({ status: "accepted" })

    setImmediate(() => {
      const job = runRecipeJob(slug, () => processEstimate(slug))
      if (!job.started) {
        logger.info({ slug }, "Joined existing recipe estimation")
      }
    })
  })

  app.post<{ Body: EstimateRequest }>("/estimate/preview", async (req, reply) => {
    const slug = requestSlug(req.body)
    if (!slug) return reply.status(400).send({ error: "Missing slug" })

    const recipe = await getRecipe(slug)
    const result = await estimateRecipe(recipe)
    logger.info(
      {
        slug,
        calories: result.perServingNutrients.kcalPer100g,
        unmatched: result.unmatchedCount,
      },
      "On-demand estimation preview complete",
    )
    return reply.send({ status: "preview", result })
  })

  app.post<{ Body: EstimateRequest }>("/estimate/apply", async (req, reply) => {
    const slug = requestSlug(req.body)
    if (!slug) return reply.status(400).send({ error: "Missing slug" })

    const recipe = await getRecipe(slug)
    if (!shouldEstimate(recipe)) {
      return reply.status(409).send({ error: "Recipe is not eligible for estimation" })
    }
    const householdId = getRecipeHouseholdId(recipe)
    const hash = computeIngredientHash(recipe)
    const result = await estimateRecipe(recipe)
    const applied = await applyEstimateAndTag(recipe, result, hash, householdId)
    logger.info({ slug, ...applied }, "On-demand estimation applied")
    return reply.send({ status: "applied", result, ...applied })
  })
}
