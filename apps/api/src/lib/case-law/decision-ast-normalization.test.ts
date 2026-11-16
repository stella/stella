import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { parseCachedDecisionAst } from "@/api/lib/case-law/decision-ast-normalization";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { currentReadWork } from "@/api/lib/observability/request-work";

const astFor = (text: string): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "decision", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    court: null,
    ecli: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "p1",
      anchorId: "p1",
      type: "paragraph",
      inlines: [{ type: "text", text }],
      plainText: text,
    },
  ],
});

test("immutable AST normalization is shared across reader and analysis calls at every document scale", () => {
  for (const scale of [1, 10]) {
    const raw = astFor("Reasoning. ".repeat(4000 * scale));
    const first = runWithQueryCounter(() => {
      const ast = parseCachedDecisionAst(raw);
      expect(currentReadWork()?.astParses).toBe(1);
      return ast;
    });
    runWithQueryCounter(() => {
      expect(parseCachedDecisionAst(raw)).toBe(first);
      expect(currentReadWork()?.astParses).toBe(0);
      expect(currentReadWork()?.cacheHits).toBe(1);
    });
    runWithQueryCounter(() => {
      expect(parseCachedDecisionAst(astFor("Updated content"))).not.toBe(first);
      expect(currentReadWork()?.astParses).toBe(1);
    });
  }
});

test("production decision AST reads use the metered normalization owner", async () => {
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const imports = [];
  for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({
    cwd: sourceRoot,
  })) {
    if (
      path.startsWith("scripts/") ||
      path.startsWith("tests/") ||
      path.includes("/tests/") ||
      path.endsWith(".test.ts") ||
      path.endsWith(".test.tsx")
    ) {
      continue;
    }
    const source = await Bun.file(
      new URL(path, new URL("../../", import.meta.url)),
    ).text();
    if (
      /import\s*\{[^}]*\bparseCaseLawDecisionAst\b[^}]*\}\s*from\s*["']@stll\/legal-ast\/case-law-reader["']/u.test(
        source,
      )
    ) {
      imports.push(path);
    }
  }
  expect(imports.toSorted()).toEqual([
    "lib/case-law/decision-ast-normalization.ts",
  ]);
});
