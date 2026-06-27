import { describe, expect, test } from "bun:test"

import { config } from "./agent-proxy"

describe("agent-proxy config", () => {
  test("has correct permissions", () => {
    expect(config.permissions).toEqual({ chat: ["create"] })
  })
})
