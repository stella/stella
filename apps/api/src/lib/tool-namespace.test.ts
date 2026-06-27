import { describe, expect, test } from "bun:test"

import { namespaceTool, resolveTool } from "./tool-namespace"

describe("namespaceTool", () => {
  test("prefixes tool with plugin id", () => {
    expect(namespaceTool("@stll/plugin-ma", "precedentSearch")).toBe("ma_precedentSearch")
  })

  test("handles plugin id without @stll/plugin- prefix", () => {
    expect(namespaceTool("custom-plugin", "myTool")).toBe("custom-plugin_myTool")
  })
})

describe("resolveTool", () => {
  test("returns namespaced tool if in list", () => {
    expect(resolveTool("ma_precedentSearch", ["ma_precedentSearch", "other_tool"])).toBe("ma_precedentSearch")
  })

  test("returns unnamespaced tool if namespaced not in list", () => {
    expect(resolveTool("ma_precedentSearch", ["precedentSearch"])).toBe("precedentSearch")
  })

  test("returns null if no match", () => {
    expect(resolveTool("ma_precedentSearch", ["other_tool"])).toBeNull()
  })
})
