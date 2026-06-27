import { describe, expect, test } from "bun:test"
import { Result } from "better-result"

import { executeInSandbox } from "./daytona-sandbox"

describe("executeInSandbox", () => {
  test("returns error when daytona is unavailable", async () => {
    const result = await executeInSandbox("echo test", { cpu: 0.5, memory: 512, timeout: 30000 })
    expect(Result.isError(result)).toBe(true)
  })
})
