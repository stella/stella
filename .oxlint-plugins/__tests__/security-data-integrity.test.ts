import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(30_000);

const lines = (...source: readonly string[]) => [...source, ""].join("\n");
const handlerPath = "apps/api/src/handlers/example.ts";

describe.serial("security and data-integrity lint boundaries", () => {
  test("reports clause publication without directive validation", async () => {
    expect(
      await lintSingleRule(
        "no-unvalidated-clause-write",
        lines(
          'import { clauses } from "@/api/db/schema";',
          "export const create = function* () {",
          "  tx.insert(clauses).values({ body });",
          "};",
        ),
        { sourcePath: "apps/api/src/handlers/clauses/create.ts" },
      ),
    ).toEqual([3]);
  });

  test("accepts clause publication after propagated directive validation", async () => {
    expect(
      await lintSingleRule(
        "no-unvalidated-clause-write",
        lines(
          'import { clauses } from "@/api/db/schema";',
          'import { validateClauseBodyDirectives } from "@/api/lib/clauses/clause-directives";',
          "export const create = function* () {",
          "  yield* validateClauseBodyDirectives(body);",
          "  tx.insert(clauses).values({ body });",
          "};",
        ),
        { sourcePath: "apps/api/src/handlers/clauses/create.ts" },
      ),
    ).toEqual([]);
  });

  test("reports an unaudited handler mutation", async () => {
    expect(
      await lintSingleRule(
        "require-audit-on-mutation",
        lines(
          "export const mutate = async (tx) => {",
          "  await tx.insert(entities).values(input);",
          "};",
        ),
        { sourcePath: handlerPath },
      ),
    ).toEqual([2]);
  });

  test("accepts a mutation that calls the injected audit recorder", async () => {
    expect(
      await lintSingleRule(
        "require-audit-on-mutation",
        lines(
          "export const mutate = async (tx, recordAuditEvent) => {",
          "  await tx.insert(entities).values(input);",
          '  await recordAuditEvent({ action: "create" });',
          "};",
        ),
        { sourcePath: handlerPath },
      ),
    ).toEqual([]);
  });

  test("reports direct audit table insertion through an imported alias", async () => {
    expect(
      await lintSingleRule(
        "no-direct-audit-log-insert",
        lines(
          'import { auditLogs as events } from "@/api/db/schema";',
          "tx.insert(events).values(input);",
        ),
        { sourcePath: handlerPath },
      ),
    ).toEqual([2]);
  });

  test("accepts physical audit insertion in its canonical recorder owner", async () => {
    expect(
      await lintSingleRule(
        "no-direct-audit-log-insert",
        lines(
          'import { auditLogs } from "@/api/db/schema";',
          "tx.insert(auditLogs).values(input);",
        ),
        { sourcePath: "apps/api/src/lib/audit-log-core.ts" },
      ),
    ).toEqual([]);
  });

  test("HTTP audit metadata wrapper cannot insert audit rows directly", async () => {
    expect(
      await lintSingleRule(
        "no-direct-audit-log-insert",
        lines(
          'import { auditLogs } from "@/api/db/schema";',
          "tx.insert(auditLogs).values(input);",
        ),
        { sourcePath: "apps/api/src/lib/audit-log.ts" },
      ),
    ).toEqual([2]);
  });

  test("reports direct property insertion and update through a schema alias", async () => {
    expect(
      await lintSingleRule(
        "no-direct-property-table-write",
        lines(
          'import { properties as rows } from "@/api/db/schema";',
          "tx.insert(rows).values(input);",
          "tx.update(rows).set(input);",
        ),
        { sourcePath: handlerPath },
      ),
    ).toEqual([2, 3]);
  });

  test("accepts property writes in their owning handlers", async () => {
    expect(
      await lintSingleRule(
        "no-direct-property-table-write",
        lines(
          'import { properties } from "@/api/db/schema";',
          "tx.insert(properties).values(input);",
          "tx.update(properties).set(input);",
        ),
        { sourcePath: "apps/api/src/handlers/properties/create.ts" },
      ),
    ).toEqual([]);
  });

  test("reports template-version mutations outside the publication owner", async () => {
    expect(
      await lintSingleRule(
        "no-direct-template-version-write",
        lines(
          'import { templateVersions as versions } from "@/api/db/schema";',
          "tx.insert(versions).values(input);",
          "tx.update(versions).set(input);",
          "tx.delete(versions);",
        ),
        { sourcePath: handlerPath },
      ),
    ).toEqual([2, 3, 4]);
  });

  test("accepts template-version mutations in their publication owner", async () => {
    expect(
      await lintSingleRule(
        "no-direct-template-version-write",
        lines(
          'import { templateVersions } from "@/api/db/schema";',
          "tx.insert(templateVersions).values(input);",
          "tx.update(templateVersions).set(input);",
          "tx.delete(templateVersions);",
        ),
        { sourcePath: "apps/api/src/lib/templates/write-template.ts" },
      ),
    ).toEqual([]);
  });

  test("reports an ingestion cursor write outside the checkpoint boundary", async () => {
    expect(
      await lintSingleRule(
        "no-direct-ingestion-checkpoint-write",
        "tx.update(sources).set({ syncCursor: cursor }).where(condition);\n",
        { sourcePath: "apps/api/src/lib/ingestion/example.ts" },
      ),
    ).toEqual([1]);
  });

  test("accepts a checkpoint callback owned by the replay-safe batch", async () => {
    expect(
      await lintSingleRule(
        "no-direct-ingestion-checkpoint-write",
        lines(
          "commitReplaySafeIngestionBatch({",
          "  checkpoint: cursor,",
          "  persistCheckpoint: (tx, checkpoint) =>",
          "    tx.update(sources).set({ syncCursor: checkpoint }).where(condition),",
          "  runInTransaction: scopedDb,",
          "});",
        ),
        { sourcePath: "apps/api/src/lib/ingestion/example.ts" },
      ),
    ).toEqual([]);
  });

  test("reports an outbound wrapper receiving a runtime-selected target", async () => {
    expect(
      await lintSingleRule(
        "require-safe-outbound-target",
        lines(
          'import { fetchWithTimeout } from "@stll/fetch";',
          "fetchWithTimeout(input.url, { timeoutMs: 10_000 });",
        ),
        { sourcePath: handlerPath },
      ),
    ).toEqual([2]);
  });

  test("accepts an outbound wrapper receiving a fixed origin", async () => {
    expect(
      await lintSingleRule(
        "require-safe-outbound-target",
        lines(
          'import { fetchWithTimeout } from "@stll/fetch";',
          'fetchWithTimeout("https://api.example.com/items", { timeoutMs: 10_000 });',
        ),
        { sourcePath: handlerPath },
      ),
    ).toEqual([]);
  });

  test("reports a package fetch without an abort signal", async () => {
    expect(
      await lintSingleRule(
        "require-fetch-timeout",
        'fetch("https://api.example.com/items", { method: "POST" });\n',
        { sourcePath: "packages/fetch/src/example.ts" },
      ),
    ).toEqual([1]);
  });

  test("accepts a package fetch with an explicit timeout signal", async () => {
    expect(
      await lintSingleRule(
        "require-fetch-timeout",
        'fetch("https://api.example.com/items", { signal: AbortSignal.timeout(10_000) });\n',
        { sourcePath: "packages/fetch/src/example.ts" },
      ),
    ).toEqual([]);
  });

  test("reports dynamic HTML passed to DOM and JSX sinks", async () => {
    expect(
      await lintSingleRule(
        "no-unsafe-inner-html",
        lines(
          "element.innerHTML = input.html;",
          "const rendered = <div dangerouslySetInnerHTML={{ __html: input.html }} />;",
        ),
        { sourcePath: "apps/web/src/components/example.tsx" },
      ),
    ).toEqual([1, 2]);
  });

  test("accepts static HTML passed to DOM and JSX sinks", async () => {
    expect(
      await lintSingleRule(
        "no-unsafe-inner-html",
        lines(
          'element.innerHTML = "<b>Static</b>";',
          'const rendered = <div dangerouslySetInnerHTML={{ __html: "<b>Static</b>" }} />;',
        ),
        { sourcePath: "apps/web/src/components/example.tsx" },
      ),
    ).toEqual([]);
  });

  test("reports credentials passed to logging and serialization sinks", async () => {
    expect(
      await lintSingleRule(
        "no-secret-in-log-sink",
        lines(
          'logger.error("request failed", { apiKey });',
          "JSON.stringify({ refreshToken });",
        ),
        { sourcePath: handlerPath },
      ),
    ).toEqual([1, 2]);
  });

  test("accepts credential metadata and token counts in logs", async () => {
    expect(
      await lintSingleRule(
        "no-secret-in-log-sink",
        lines(
          'logger.info("usage", { inputTokens, hasApiKey });',
          "JSON.stringify({ accessTokenExpiresAt });",
        ),
        { sourcePath: handlerPath },
      ),
    ).toEqual([]);
  });
});
