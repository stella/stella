import { Result } from "better-result";
import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { discoverHandler } from "./discover";

test("stored template discovery accepts an id without upload bytes and propagates its typed refusal", async () => {
  const { scopedDb } = createScopedDbMock({
    query: { templates: { findFirst: async () => null } },
  });
  const result = await discoverHandler({
    organizationId: toSafeId<"organization">("org_discover"),
    scopedDb,
    body: { templateId: toSafeId<"template">("tmpl_missing") },
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toMatchObject({
      status: 404,
      message: "Template not found",
    });
  }
});

test("template discovery requires either a stored id or upload bytes", async () => {
  const result = await discoverHandler({
    organizationId: toSafeId<"organization">("org_discover"),
    body: {},
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toMatchObject({
      status: 400,
      message: "A file or templateId is required",
    });
  }
});
