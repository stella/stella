import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { feedbackReports } from "@/api/db/schema";
import {
  feedbackReportStore,
  type FeedbackReportRow,
} from "@/api/lib/db/feedback-report-store";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

setDefaultTimeout(120_000);

const row = (receipt: string): FeedbackReportRow => ({
  kind: "bug",
  area: "documents",
  receipt,
  title: "Concurrent report",
  whatHappened: "Two requests arrived together",
  expected: null,
  steps: null,
  evidence: null,
  context: null,
  serverVersion: "test",
  instance: null,
  via: "intake",
  userId: null,
  organizationId: null,
  redactions: 0,
  fingerprint: `concurrency-${Bun.randomUUIDv7()}`,
});

if (!runPostgresTests) {
  describe.skip("feedback report store PostgreSQL contract", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgresTests).toBe(false);
    });
  });
} else {
  describe("feedback report store PostgreSQL contract", () => {
    test("concurrent identical inserts converge under the advisory lock", async () => {
      const first = row("FB-AAAA-1111");
      const second = { ...first, receipt: "FB-BBBB-2222" };
      const since = new Date();

      try {
        const results = await Promise.all([
          feedbackReportStore.insertIfAbsent({ row: first, since }),
          feedbackReportStore.insertIfAbsent({ row: second, since }),
        ]);

        expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
        const receipts = results.map(({ receipt }) => receipt);
        const receipt = receipts.at(0);
        expect(receipt).toBe(receipts.at(1));
        if (receipt === undefined) {
          throw new Error("expected a receipt");
        }
        expect(["FB-AAAA-1111", "FB-BBBB-2222"]).toContain(receipt);
      } finally {
        await rootDb
          .delete(feedbackReports)
          .where(eq(feedbackReports.fingerprint, first.fingerprint));
      }
    });
  });
}
