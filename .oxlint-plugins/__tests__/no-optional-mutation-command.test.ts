import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

describe("no-optional-mutation-command", () => {
  test("reports commands that admit conflicting operations", async () => {
    expect(
      await lintSingleRule(
        "no-optional-mutation-command",
        'import { useMutation } from "@tanstack/react-query";\nuseMutation({ mutationFn: async (body: { name?: string; color?: string }) => save(body) });',
      ),
    ).toEqual([2]);
  });
  test("reports aliases with identity fields and an optional bag", async () => {
    expect(
      await lintSingleRule(
        "no-optional-mutation-command",
        'import { useMutation as mutate } from "@tanstack/react-query";\ntype Update = { workspaceId: string; name?: string; color?: string };\nmutate({ mutationFn: async (body: Update) => save(body) });',
      ),
    ).toEqual([3]);
  });
  test("accepts explicit operation variants", async () => {
    expect(
      await lintSingleRule(
        "no-optional-mutation-command",
        'import { useMutation } from "@tanstack/react-query";\ntype Update = { type: "name"; value: string } | { type: "color"; value: string };\nuseMutation({ mutationFn: async (body: Update) => save(body) });',
      ),
    ).toEqual([]);
  });
  test("accepts one atomic payload with optional metadata", async () => {
    expect(
      await lintSingleRule(
        "no-optional-mutation-command",
        'import { useMutation } from "@tanstack/react-query";\nuseMutation({ mutationFn: async (body: { value: string; note?: string; color?: string }) => save(body) });',
      ),
    ).toEqual([]);
  });
});
