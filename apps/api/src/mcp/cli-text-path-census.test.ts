/**
 * A windowed-text CLI leaf prints the value at its `textPath`. When the tool's
 * output stops carrying a string there (a batch envelope replacing one
 * subject, a renamed field), the CLI has nothing to print. These read every
 * annotated path against the tool's executable output contract, so the
 * annotation cannot name a path the projection does not carry.
 */
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { DEFAULT_MCP_CLI_ANNOTATIONS } from "@/api/mcp/static-cli-metadata";
import { getStaticMcpToolOutputContract } from "@/api/mcp/static-tool-definitions";
import { deriveUncompactedMcpOutputSchema } from "@/api/mcp/valibot-tool-definition";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The branches a schema allows: its `anyOf` members, or the schema itself. */
const branches = (schema: unknown): readonly unknown[] =>
  isRecord(schema) && Array.isArray(schema["anyOf"])
    ? schema["anyOf"].flatMap(branches)
    : [schema];

const typeOf = (schema: unknown): unknown =>
  isRecord(schema) ? schema["type"] : undefined;

/**
 * Why the value at `path` is not always a string or null, or null when it is.
 * Every segment must be a required property of every object branch on the
 * way: an optional or missing one is a response without the text.
 */
const textPathProblem = (schema: unknown, path: string): string | null => {
  let holders: readonly unknown[] = [schema];
  for (const segment of path.split(".")) {
    const next: unknown[] = [];
    for (const holder of holders.flatMap(branches)) {
      if (typeOf(holder) === "null") {
        return `a null parent before \`${segment}\``;
      }
      if (!isRecord(holder) || !isRecord(holder["properties"])) {
        return `a non-object parent before \`${segment}\``;
      }
      const required = holder["required"];
      if (!Array.isArray(required) || !required.includes(segment)) {
        return `\`${segment}\` is not a required property`;
      }
      next.push(holder["properties"][segment]);
    }
    holders = next;
  }
  for (const leaf of holders.flatMap(branches)) {
    const type = typeOf(leaf);
    if (type !== "string" && type !== "null") {
      return `the value is ${JSON.stringify(leaf)}, not a string or null`;
    }
  }
  return null;
};

const windowedLeaves = Object.entries(DEFAULT_MCP_CLI_ANNOTATIONS).flatMap(
  ([name, annotation]) =>
    "windowedText" in annotation
      ? [[name, annotation.windowedText.textPath] as const]
      : [],
);

describe("CLI windowed-text paths", () => {
  test("at least one tool is a windowed-text leaf", () => {
    expect(windowedLeaves.length).toBeGreaterThan(0);
  });

  test.each(windowedLeaves)(
    "%s carries a string or null at %s",
    (name, textPath) => {
      const contract = getStaticMcpToolOutputContract(name);
      expect(contract, `No output contract for ${name}`).toBeDefined();
      if (contract === undefined) {
        return;
      }
      const schema = deriveUncompactedMcpOutputSchema(
        contract.outputSchemaSource,
      );
      expect(textPathProblem(schema, textPath)).toBeNull();
    },
  );

  test("a path the projection does not carry is reported", () => {
    // The batch read is the shape a single-text path no longer matches.
    const contract =
      getStaticMcpToolOutputContract("read_case_law_decision") ??
      panic("read_case_law_decision has no output contract");
    const schema = deriveUncompactedMcpOutputSchema(
      contract.outputSchemaSource,
    );
    expect(textPathProblem(schema, "decision.text")).toBe(
      "`decision` is not a required property",
    );
    expect(textPathProblem(schema, "items")).toContain("not a string or null");
  });
});
