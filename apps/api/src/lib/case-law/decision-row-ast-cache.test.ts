import { expect, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import { createDecisionRowAstCache } from "@/api/lib/case-law/decision-row-ast-cache";
import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import {
  currentReadWork,
  recordDbResult,
} from "@/api/lib/observability/request-work";

const decisionId = createSafeId<"caseLawDecision">();

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

test("database document windows transfer and parse no AST after their live version is cached", async () => {
  for (const scale of [1, 10]) {
    const cache = createDecisionRowAstCache({ maxBytes: 8 * 1024 * 1024 });
    const document = astFor("reasoning ".repeat(4000 * scale));
    let reads = 0;
    const read = async () => {
      reads++;
      recordDbResult([{ documentAst: document }]);
      return document;
    };
    const first = await runWithQueryCounter(async () => {
      const ast = await cache({
        documentId: decisionId,
        key: "decision/update-1",
        read,
      });
      expect(currentReadWork()?.dbResultBytes).toBeGreaterThan(4000 * scale);
      expect(currentReadWork()?.astParses).toBe(1);
      return ast;
    });
    await runWithQueryCounter(async () => {
      const cached = await cache({
        documentId: decisionId,
        key: "decision/update-1",
        read,
      });
      expect(currentReadWork()?.dbResultBytes).toBe(0);
      expect(cached).toBe(first);
      expect(currentReadWork()?.astParses).toBe(0);
      expect(currentReadWork()?.cacheHits).toBe(1);
    });
    expect(reads).toBe(1);
    expect(Object.isFrozen(first?.blocks)).toBe(true);
    await cache({ documentId: decisionId, key: "decision/update-2", read });
    expect(reads).toBe(2);
  }
});

test("concurrent pages share one row payload query and a rejected query is retried", async () => {
  const cache = createDecisionRowAstCache({ maxBytes: 1024 * 1024 });
  let reads = 0;
  const read = async () => {
    reads++;
    await Promise.resolve();
    return astFor("body");
  };
  const [first, second] = await Promise.all([
    cache({ documentId: decisionId, key: "v1", read }),
    cache({ documentId: decisionId, key: "v1", read }),
  ]);
  expect(first).toBe(second);
  expect(reads).toBe(1);
  const rejection = await rejectionOf(
    cache({
      documentId: decisionId,
      key: "v2",
      read: async () => {
        throw new Error("database unavailable");
      },
    }),
  );
  expect(rejection).toBeInstanceOf(Error);
  expect(String(rejection)).toContain("database unavailable");
  expect(
    await cache({ documentId: decisionId, key: "v2", read }),
  ).not.toBeNull();
  expect(reads).toBe(2);
});

test("a row AST larger than the budget is never retained", async () => {
  const cache = createDecisionRowAstCache({ maxBytes: 4096 });
  let reads = 0;
  const read = async () => {
    reads++;
    return astFor("x".repeat(10_000));
  };
  await cache({ documentId: decisionId, key: "oversized", read });
  await cache({ documentId: decisionId, key: "oversized", read });
  expect(reads).toBe(2);
});
