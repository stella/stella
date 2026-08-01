import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { createMemoryBodySchema } from "@/api/handlers/memories/create-schema";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const BASE_MEMORY = {
  content: "Use concise headings",
  kind: "preference",
} as const;

describe("create memory request boundary", () => {
  test("accepts only ownership fields valid for the selected scope", () => {
    expect(
      Value.Check(createMemoryBodySchema, {
        ...BASE_MEMORY,
        scope: "user",
      }),
    ).toBe(true);
    expect(
      Value.Check(createMemoryBodySchema, {
        ...BASE_MEMORY,
        scope: "workspace",
        workspaceId: WORKSPACE_ID,
      }),
    ).toBe(true);
    expect(
      Value.Check(createMemoryBodySchema, {
        ...BASE_MEMORY,
        scope: "user",
        workspaceId: WORKSPACE_ID,
      }),
    ).toBe(false);
    expect(
      Value.Check(createMemoryBodySchema, {
        ...BASE_MEMORY,
        scope: "workspace",
      }),
    ).toBe(false);
  });
});
