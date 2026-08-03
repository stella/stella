import { expect, test } from "bun:test";

import { type BenchResult, renderMarkdown } from "../report";

test("development Markdown ends with exactly one newline", () => {
  const result = {
    createdAt: "2026-08-02T00:00:00.000Z",
    gitSha: "test",
    hardware: "test",
    runtime: "test",
    corpus: {
      documents: 0,
      entities: 0,
      byLanguage: {},
      byLabel: {},
    },
    matching: { primary: "test", secondary: "test" },
    libraries: [],
  } as const satisfies BenchResult;

  expect(renderMarkdown(result)).toMatch(/[^\n]\n$/);
});
