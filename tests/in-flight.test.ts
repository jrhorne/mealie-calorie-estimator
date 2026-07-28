import { describe, expect, it, vi } from "vitest"
import { runRecipeJob } from "../src/utils/in-flight.js"

describe("runRecipeJob", () => {
  it("coalesces concurrent work for the same recipe and permits a later rerun", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const work = vi.fn(async () => gate)

    const first = runRecipeJob("pasta", work)
    const duplicate = runRecipeJob("pasta", work)

    expect(first.started).toBe(true)
    expect(duplicate.started).toBe(false)
    expect(duplicate.promise).toBe(first.promise)
    expect(work).toHaveBeenCalledTimes(0)

    await Promise.resolve()
    expect(work).toHaveBeenCalledTimes(1)

    release?.()
    await first.promise

    const later = runRecipeJob("pasta", work)
    expect(later.started).toBe(true)
    await later.promise
    expect(work).toHaveBeenCalledTimes(2)
  })

  it("allows different recipes to run concurrently", async () => {
    const workA = vi.fn(async () => undefined)
    const workB = vi.fn(async () => undefined)

    const a = runRecipeJob("a", workA)
    const b = runRecipeJob("b", workB)
    await Promise.all([a.promise, b.promise])

    expect(a.started).toBe(true)
    expect(b.started).toBe(true)
  })
})
