import { describe, expect, test } from "bun:test"
import { Result } from "better-result"

import { getOrCreateSession } from "./opencode-session-manager"

describe("getOrCreateSession", () => {
  test("returns error when opencode is unavailable", async () => {
    const result = await getOrCreateSession("thread-1", "workspace-1", "user-token")
    expect(Result.isError(result)).toBe(true)
  })
})
