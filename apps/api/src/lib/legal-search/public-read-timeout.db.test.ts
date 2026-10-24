import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import Elysia, { t } from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { PUBLIC_READ_STATEMENT_TIMEOUT_MS } from "@/api/db/shared-pool-timeouts";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { executedRows } from "@/api/lib/db/executed-rows";
import { PUBLIC_READ_TIMEOUT_CODE } from "@/api/lib/legal-search/public-read-timeout";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import { isRecord } from "@/api/lib/type-guards";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("public read statement timeout against PostgreSQL", () => {
    test("requires the PostgreSQL test runner", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("public read statement timeout against PostgreSQL", () => {
    const readBudget = createSafeBoundedPublicHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "public_indexing" },
        cache: { kind: "none" },
        query: t.Object({ slow: t.Optional(t.Literal("true")) }),
        response: safePublicHandlerResponseSchemasWithStatusText(
          t.Object({ budget: t.String() }),
        ),
      },
      async function* ({ query, request }) {
        const readDb = new URL(request.url).pathname.includes("/law/")
          ? legislationPublicReadDb
          : caseLawPublicReadDb;
        const response = yield* Result.await(
          Result.tryPromise(
            async () =>
              await readDb(async (tx) => {
                if (query.slow === "true") {
                  await tx.execute(
                    sql`SELECT pg_sleep(${PUBLIC_READ_STATEMENT_TIMEOUT_MS.search / 1000 + 5})`,
                  );
                }
                const row = executedRows(
                  await tx.execute(
                    sql`SELECT current_setting('statement_timeout') AS budget`,
                  ),
                ).at(0);
                if (!isRecord(row) || typeof row["budget"] !== "string") {
                  panic("PostgreSQL must return the active statement timeout");
                }
                return { budget: row["budget"] };
              }),
          ),
        );
        return Result.ok(response);
      },
    );
    // Mount the production route identifiers so the same policy classifier runs.
    const app = new Elysia({ prefix: STELLA_API_VERSION_PREFIX })
      .get("/law/statutes/search", readBudget.handler, readBudget.config)
      .post("/case/decisions/search", readBudget.handler, readBudget.config);

    test(
      "a server-cancelled public search returns a bounded typed error and the next read succeeds",
      async () => {
        const response = await app.handle(
          new Request(
            `http://localhost${STELLA_API_VERSION_PREFIX}/law/statutes/search?slow=true`,
          ),
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          code: PUBLIC_READ_TIMEOUT_CODE,
          message: "Public read timed out. Please try again.",
        });
        const normal = await app.handle(
          new Request(
            `http://localhost${STELLA_API_VERSION_PREFIX}/law/statutes/search`,
          ),
        );
        expect(normal.status).toBe(200);
        expect(await normal.json()).toEqual({ budget: "30s" });
      },
      PUBLIC_READ_STATEMENT_TIMEOUT_MS.search + 15_000,
    );

    test("case-law reads use the same registered request budget without authentication", async () => {
      const response = await app.handle(
        new Request(
          `http://localhost${STELLA_API_VERSION_PREFIX}/case/decisions/search`,
          { method: "POST" },
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ budget: "30s" });
    });
  });
}
