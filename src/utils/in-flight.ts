const recipeJobs = new Map<string, Promise<void>>()

export function runRecipeJob(
  slug: string,
  work: () => Promise<void>,
): { started: boolean; promise: Promise<void> } {
  const existing = recipeJobs.get(slug)
  if (existing) {
    return { started: false, promise: existing }
  }

  const promise = Promise.resolve()
    .then(work)
    .finally(() => {
      if (recipeJobs.get(slug) === promise) {
        recipeJobs.delete(slug)
      }
    })

  recipeJobs.set(slug, promise)
  return { started: true, promise }
}
