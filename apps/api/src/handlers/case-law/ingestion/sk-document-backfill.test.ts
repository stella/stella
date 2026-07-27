/**
 * The queue's priority is expressed entirely in SQL, and a wrong
 * predicate or ORDER BY is invisible at runtime: the loop still drains,
 * just in the wrong order, and the decisions readers are waiting on
 * stay unreadable. These assertions pin the shape; the Postgres suite
 * (`sk-document-backfill.db.test.ts`) pins the resulting row order.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  MAX_PRIORITY_FETCH_ATTEMPTS,
  remainingDocumentOrder,
  remainingDocumentPredicate,
  requestedDocumentOrder,
  requestedDocumentPredicate,
} from "@/api/handlers/case-law/ingestion/sk-document-backfill";

const dialect = new PgDialect();

const compileCondition = (condition: SQL | undefined) =>
  dialect.sqlToQuery(condition ?? panic("queue predicate is empty"));

const compileOrder = (fragments: readonly SQL[]) =>
  fragments.map((fragment) => dialect.sqlToQuery(fragment).sql).join(", ");

describe("deferred document queue shape", () => {
  test("both tiers only take decisions that are still waiting", () => {
    for (const predicate of [
      requestedDocumentPredicate,
      remainingDocumentPredicate,
    ]) {
      const { sql } = compileCondition(predicate);

      expect(sql).toContain(`"fulltext" is null`);
      expect(sql).toContain(`"document_url" is not null`);
    }
  });

  test("the priority tier is what a reader asked for, within its retries", () => {
    const { sql, params } = compileCondition(requestedDocumentPredicate);

    expect(sql).toContain(`"document_fetch_requested_at" is not null`);
    expect(sql).toContain(`"document_fetch_attempts" <`);
    expect(params).toContain(MAX_PRIORITY_FETCH_ATTEMPTS);
  });

  test("the remaining tier is everything the priority tier leaves", () => {
    const { sql, params } = compileCondition(remainingDocumentPredicate);

    expect(sql).toContain(`"document_fetch_requested_at" is null`);
    expect(sql).toContain(`"document_fetch_attempts" >=`);
    expect(params).toContain(MAX_PRIORITY_FETCH_ATTEMPTS);
    // The two tiers partition the pending set: the priority tier is
    // "requested and under the retry cap", so its complement has to be
    // an OR of the two negations, or decisions fall out of the queue.
    expect(sql).toContain(" or ");
  });

  test("requested decisions drain oldest request first", () => {
    expect(compileOrder(requestedDocumentOrder)).toBe(
      `"case_law_decisions"."document_fetch_requested_at" asc, "case_law_decisions"."id" asc`,
    );
  });

  test("the rest drain newest first, undated decisions last", () => {
    expect(compileOrder(remainingDocumentOrder)).toBe(
      `"case_law_decisions"."decision_date" desc nulls last, "case_law_decisions"."id" asc`,
    );
  });
});
