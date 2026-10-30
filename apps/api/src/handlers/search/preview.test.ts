import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { readFailureBrand } from "@stll/errors";

import {
  searchPreviewBodySchema,
  searchPreviewHandler,
} from "@/api/handlers/search/preview";
import { ArtefactProvenanceDecodeError } from "@/api/lib/ai-generation/provenance";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

describe("search preview request", () => {
  test("accepts filter-only searches without query text", () => {
    expect(
      v.is(searchPreviewBodySchema, {
        query: "",
        resultId: "00000000-0000-4000-8000-000000000001",
        type: "document",
      }),
    ).toBe(true);
  });
});

const query = {
  query: "motion",
  resultId: "00000000-0000-4000-8000-000000000001",
  type: "chat",
  organizationId: toSafeId<"organization">("org_1"),
  userId: toSafeId<"user">("user_1"),
  accessibleWorkspaceIds: [],
} satisfies Parameters<typeof searchPreviewHandler>[0]["query"];

const { scopedDb } = createScopedDbMock({});

test("unreadable preview provenance is a server failure rather than a missing result", async () => {
  const cause = new ArtefactProvenanceDecodeError({
    message: "Invalid stored artefact provenance",
  });
  const result = await searchPreviewHandler({
    query,
    scopedDb,
    readPreview: async () => Result.err(cause),
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.status).toBe(500);
    expect(result.error.cause).toBe(cause);
    expect(readFailureBrand(result.error)).toEqual({
      reason: "tagged_failure",
      source: "instance",
    });
  }
});

test("a missing search preview remains a not-found failure", async () => {
  const result = await searchPreviewHandler({
    query,
    scopedDb,
    readPreview: async () => Result.ok(null),
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.status).toBe(404);
  }
});

test("a readable search preview preserves its content", async () => {
  const result = await searchPreviewHandler({
    query,
    scopedDb,
    readPreview: async () =>
      Result.ok({ type: "plain-text", content: "Motion" }),
  });
  expect(result.unwrap()).toEqual({ type: "plain-text", content: "Motion" });
});
