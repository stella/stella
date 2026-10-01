import { describe, expect, test } from "bun:test";

import { backfillEntrypoints } from "./backfill-entrypoint";

const after = "00000000-0000-0000-0000-000000000123";

describe("converted backfill entrypoints wire operator input to the gated runtime", () => {
  const fixtures = [
    {
      entrypoint: "citation-authority",
      args: [
        "--batch",
        "234",
        "--after",
        after,
        "--as-of",
        "2026-10-01T08:00:00Z",
      ],
      expected: {
        name: `citation-authority:2026-10-01T08:00:00.000Z:${after}`,
        tableName: "case_law_decisions",
        initialSize: 234,
      },
    },
    {
      entrypoint: "citation-keys",
      args: ["--recanonicalize"],
      expected: {
        name: "citation-keys:stale",
        tableName: "case_law_decisions",
        initialSize: 5000,
      },
    },
    {
      entrypoint: "source-document-ids",
      args: ["--adapter", "sk-courts"],
      expected: {
        name: "source-document-ids",
        tableName: "case_law_decisions",
        initialSize: 2000,
      },
    },
    {
      entrypoint: "legislation-work-names",
      args: ["--apply", "--page", "234", "--limit", "456", "--after", after],
      expected: {
        name: `legislation-work-names:${after}`,
        tableName: "legislation_documents",
        initialSize: 234,
      },
    },
    {
      entrypoint: "property-roles",
      args: [],
      expected: {
        name: "property-roles",
        tableName: "properties",
        initialSize: 234,
      },
    },
    {
      entrypoint: "statute-citation-counts",
      args: [],
      expected: {
        name: "statute-citation-counts",
        tableName: "case_law_decisions",
        initialSize: 500,
      },
    },
    {
      entrypoint: "statute-slugs",
      args: [],
      expected: {
        name: "statute-slugs",
        tableName: "legislation_documents",
        initialSize: 200,
      },
    },
  ] as const satisfies readonly {
    entrypoint: keyof typeof backfillEntrypoints;
    args: readonly string[];
    expected: { name: string; tableName: string; initialSize: number };
  }[];

  test("every converted entrypoint has an exercised smoke", () => {
    expect(
      fixtures
        .map(({ entrypoint }) => entrypoint)
        .toSorted()
        .join("\n"),
    ).toBe(Object.keys(backfillEntrypoints).toSorted().join("\n"));
  });

  for (const { entrypoint, args, expected } of fixtures) {
    test(entrypoint, async () => {
      const plan = backfillEntrypoints[entrypoint]({
        args,
        environment: { PROPERTY_ROLE_BACKFILL_BATCH_SIZE: "234" },
      });
      const runtime = { step: async () => ({ status: "held" }) };
      let calls = 0;
      const opened = await plan.open(async (options) => {
        calls++;
        expect(options).toEqual(expected);
        return runtime;
      });
      expect(opened).toBe(runtime);
      expect(await opened.step()).toEqual({ status: "held" });
      expect(calls).toBe(1);
      if ("adapter" in plan) {
        expect(plan.adapter).toBe("sk-courts");
      }
      if ("apply" in plan) {
        expect(plan.apply).toBe(true);
        expect(plan).toHaveProperty("limit", 456);
      }
    });
  }

  test("invalid operator input fails before opening a gated runtime", () => {
    expect(() =>
      backfillEntrypoints["citation-authority"]({ args: ["--batch", "0"] }),
    ).toThrow("--batch requires a positive integer");
    expect(() =>
      backfillEntrypoints["source-document-ids"]({ args: ["--adapter"] }),
    ).toThrow("--adapter requires a value");
    expect(() =>
      backfillEntrypoints["legislation-work-names"]({
        args: ["--apply", "--dry-run"],
      }),
    ).toThrow("--apply contradicts --dry-run");
  });
});
