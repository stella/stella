import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects requested page defaults and clamps without normalization", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      "function list(query, body) {\n const limit = Math.min(query.limit ?? 25, 100);\n const pageSize = body.pageSize || 20;\n}",
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([2, 3]);
});

test("rejects imported limit defaults and native MCP defaults", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      'import { LIMITS as budgets } from "@/api/lib/limits";\nimport { DEFAULT_LIST_LIMIT as fallback } from "@/api/mcp/tool-utils";\nfunction list() {\n const limit = budgets.entityPageSizeDefault;\n const windowSize = fallback;\n}',
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([4, 5]);
});

test("accepts a canonical aliased normalizer around the complete expression", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      'import { normalizeTenantPageLimit as normalize } from "@/api/lib/rate-limit/action-size-limits";\nfunction list(query) { const limit = normalize(Math.min(query.limit ?? 20, 100)); }',
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([]);
});

test("does not trust same named normalizers from another owner", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      'import { normalizeTenantPageLimit } from "./limits";\nfunction list(query) { const limit = normalizeTenantPageLimit(query.limit); }',
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([2]);
});

test("accepts public corpus page budgets", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      "function list(query) { const limit = query.limit ?? 25; }",
      { sourcePath: "apps/api/src/handlers/case-law/list.ts" },
    ),
  ).toEqual([]);
});

test("accepts anonymous factories only from the defining module", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      'import { createSafePublicHandler as publicHandler } from "@/api/lib/api-handlers";\npublicHandler({}, ({ query }) => { const limit = query.limit; });',
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([]);
});

test("keeps same named anonymous factories from other modules scoped", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      'import { createSafePublicHandler } from "./handler";\nfunction list(query) { const limit = query.limit; }',
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([2]);
});

test("accepts schema declarations and query builder limits", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      "const schema = v.object({ limit: v.optional(v.number()) });\nfunction list(db) { const limit = db.select().limit(25); }",
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([]);
});

test("keeps native MCP page limits in tenant scope", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      "function list(input) { const limit = input.limit ?? 25; }",
      { sourcePath: "apps/api/src/mcp/list.ts" },
    ),
  ).toEqual([1]);
});

test("rejects normalization of only part of the resolved page expression", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      'import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";\nfunction list(query) { const limit = Math.min(normalizeTenantPageLimit(query.limit), 100); }',
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([2]);
});

test("keeps tenant functions scoped beside an anonymous handler", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      'import { createSafePublicHandler as publicHandler } from "@/api/lib/api-handlers";\npublicHandler({}, ({ query }) => { const limit = query.limit; });\nfunction list(query) { const limit = query.limit; }',
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([3]);
});

test("associates a named callback only with its canonical anonymous owner", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      'import { createSafePublicHandler as publicHandler } from "@/api/lib/api-handlers";\nfunction list(query) { const limit = query.limit; }\npublicHandler({}, list);\nfunction tenant(query) { const limit = query.limit; }',
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([4]);
});

test("keeps shared anonymous and tenant callbacks in tenant scope", async () => {
  expect(
    await lintSingleRule(
      "require-tenant-page-limit",
      'import { createSafePublicHandler, createSafeRootHandler } from "@/api/lib/api-handlers";\nfunction list(query) { const limit = query.limit; }\ncreateSafePublicHandler({}, list);\ncreateSafeRootHandler({}, list);',
      { sourcePath: "apps/api/src/handlers/entities/list.ts" },
    ),
  ).toEqual([2]);
});
