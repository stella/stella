import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { OwnershipEntry } from "./ownership";
import {
  OWNERSHIP,
  renderOwnershipDocument,
  validateOwnership,
} from "./ownership";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const entry = (overrides: Partial<OwnershipEntry>): OwnershipEntry => ({
  id: "example",
  capability: "An example capability",
  owner: ["scripts/ownership.ts"],
  summary: "One owner so the behavior is decided once.",
  enforcement: { kind: "none" },
  ...overrides,
});

describe("renderOwnershipDocument", () => {
  test("renders the same bytes for the same table", () => {
    expect(renderOwnershipDocument(OWNERSHIP)).toBe(
      renderOwnershipDocument(OWNERSHIP),
    );
  });

  test("renders one row per entry, keyed by id", () => {
    const rendered = renderOwnershipDocument(OWNERSHIP);
    for (const { id } of OWNERSHIP) {
      expect(rendered).toContain(`| \`${id}\` — `);
    }
  });
});

describe("validateOwnership", () => {
  test("accepts the committed table", () => {
    expect(validateOwnership(OWNERSHIP, repoRoot)).toEqual([]);
  });

  test("rejects an owner path that does not exist", () => {
    expect(
      validateOwnership(
        [entry({ owner: ["scripts/not-a-module.ts"] })],
        repoRoot,
      ),
    ).toEqual(["example: owner path does not exist: scripts/not-a-module.ts"]);
  });

  test("rejects an allowed path that does not exist", () => {
    const problems = validateOwnership(
      [
        entry({
          enforcement: {
            kind: "import",
            specifiers: ["@/api/lib/redis-client"],
            allowed: [{ path: "scripts/not-a-caller.ts", reason: "example" }],
          },
        }),
      ],
      repoRoot,
    );
    expect(problems).toEqual([
      "example: allowed path does not exist: scripts/not-a-caller.ts",
    ]);
  });

  test("rejects a duplicate id", () => {
    expect(validateOwnership([entry({}), entry({})], repoRoot)).toEqual([
      "duplicate ownership id: example",
    ]);
  });
});
