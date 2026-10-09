import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { LEGAL_RESOLVE_TOOL_SET } from "@/api/mcp/legal-resolve-tools";

import { generateRouteMap } from "../../../../packages/cli/src/generate-route-map";
import { composeCliToolInput } from "./cli-tool-input";

const definition = LEGAL_RESOLVE_TOOL_SET.definitions.find(
  (tool) => tool.name === "resolve_law_citation",
);
if (definition === undefined) {
  panic("law resolver definition missing");
}
const tree = generateRouteMap([definition], {
  resolve_law_citation: { command: ["resolve"], inputOnly: ["source"] },
});
if (tree.kind !== "route") {
  panic("expected CLI route");
}
const leaf = tree.children["resolve"];
if (leaf?.kind !== "leaf") {
  panic("expected law resolver leaf");
}
const spec = leaf.spec;
const compose = async (input?: string) =>
  await composeCliToolInput({
    spec,
    flags: new Map([
      ["country", "CZE"],
      ["section", "1729"],
      ["as-of", "2020-01-01"],
      ...(input === undefined ? [] : [["input", input] as const]),
    ]),
    repeatedFlags: new Map(),
  });

describe("CLI evaluation input composition", () => {
  test("missing input-only source fails the owning tool schema", async () => {
    const result = await compose();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      panic(result.message);
    }
    expect(v.safeParse(definition.inputSchemaSource, result.args).success).toBe(
      false,
    );
  });
  test("inline source plus flags satisfies the complete owning schema", async () => {
    const result = await compose(
      JSON.stringify({
        source: { type: "citation", citation: "89/2012 Sb." },
        as_of: "2021-01-01",
      }),
    );
    if (!result.ok) {
      panic(result.message);
    }
    expect(v.safeParse(definition.inputSchemaSource, result.args).success).toBe(
      true,
    );
    expect(result.args["as_of"]).toBe("2020-01-01");
  });
  test("contradictory source fields fail the owning schema", async () => {
    const result = await compose(
      JSON.stringify({
        source: { type: "citation", citation: "89/2012 Sb.", year: 2012 },
      }),
    );
    if (!result.ok) {
      panic(result.message);
    }
    expect(v.safeParse(definition.inputSchemaSource, result.args).success).toBe(
      false,
    );
  });
  test.each(["-", "@/not-read.json", "[]", "{"])(
    "rejects non-inline or invalid input %s",
    async (input) => {
      expect((await compose(input)).ok).toBe(false);
    },
  );
});
