import { beforeEach, describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { HIGHLIGHT_START, HIGHLIGHT_STOP } from "@/api/lib/search/highlight";
import {
  clearRootDbMocks,
  rootDbExecuteMock,
} from "@/api/tests/helpers/mock-root-db";

const { readSearchPreview } = await import("@/api/lib/search/preview");

const previewQuery = {
  query: "",
  resultId: "00000000-0000-4000-8000-000000000003",
  type: "document",
  organizationId: toSafeId<"organization">(
    "00000000-0000-4000-8000-000000000001",
  ),
  userId: toSafeId<"user">("user_1"),
  accessibleWorkspaceIds: [
    toSafeId<"workspace">("00000000-0000-4000-8000-000000000002"),
  ],
} as const;

describe("search preview rendering contract", () => {
  beforeEach(clearRootDbMocks);

  test("returns filter-only source as plain text without interpreting sentinels", async () => {
    const content = "literal __HL_START__code__HL_STOP__";
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        preview: {
          content,
          normalizedSourceContent: null,
          sourceContent: null,
          useUnaccent: true,
        },
      },
    ]);

    expect(await readSearchPreview(previewQuery)).toEqual({
      type: "plain-text",
      content,
    });
  });

  test("returns restored query matches as highlighted HTML", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        preview: {
          content: `${HIGHLIGHT_START}resume${HIGHLIGHT_STOP}`,
          normalizedSourceContent: "resume",
          sourceContent: "résumé",
          useUnaccent: true,
        },
      },
    ]);

    expect(
      await readSearchPreview({ ...previewQuery, query: "resume" }),
    ).toEqual({
      type: "highlighted-html",
      content: "<mark>résumé</mark>",
    });
  });

  test("preserves legacy sentinel-like source text in highlighted previews", async () => {
    const literal = "__HL_START__code__HL_STOP__";
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        preview: {
          content: `${literal} ${HIGHLIGHT_START}resume${HIGHLIGHT_STOP}`,
          normalizedSourceContent: `${literal} resume`,
          sourceContent: `${literal} résumé`,
          useUnaccent: true,
        },
      },
    ]);

    expect(
      await readSearchPreview({ ...previewQuery, query: "resume" }),
    ).toEqual({
      type: "highlighted-html",
      content: `${literal} <mark>résumé</mark>`,
    });
  });

  test("rejects rows that mix plain and highlighted source fields", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        preview: {
          content: "preview",
          normalizedSourceContent: "preview",
          sourceContent: null,
          useUnaccent: true,
        },
      },
    ]);

    expect(await readSearchPreview(previewQuery)).toBeNull();
  });
});
