import { beforeEach, describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { HIGHLIGHT_START, HIGHLIGHT_STOP } from "@/api/lib/search/highlight";
import { readSearchPreview as readSearchPreviewWithDatabase } from "@/api/lib/search/preview";
import {
  clearRootDbMocks,
  rootDbExecuteMock,
  rootDbTestDouble,
} from "@/api/tests/helpers/mock-root-db";

const readSearchPreview = async (
  input: Parameters<typeof readSearchPreviewWithDatabase>[0],
) => await readSearchPreviewWithDatabase(input, rootDbTestDouble);

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

  test("returns bounded chat messages with their speaker roles and visible text", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: false,
            role: "user",
            content: {
              version: 1,
              data: [{ type: "text", text: "Review this agreement" }],
            },
          },
          {
            id: "00000000-0000-4000-8000-000000000011",
            isTarget: true,
            role: "assistant",
            content: {
              version: 2,
              data: [
                { type: "text", content: "## Key issue" },
                { type: "text", content: "The cap is uncapped." },
              ],
            },
          },
        ],
      },
    ]);

    expect(await readSearchPreview({ ...previewQuery, type: "chat" })).toEqual({
      type: "chat-messages",
      messages: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          role: "user",
          content: "Review this agreement",
        },
        {
          id: "00000000-0000-4000-8000-000000000011",
          role: "assistant",
          content: "## Key issue\n\nThe cap is uncapped.",
        },
      ],
    });
  });

  test("bounds the combined visible text in a chat preview", async () => {
    const oversizedContent = "a".repeat(20_000);
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: false,
            role: "user",
            content: {
              version: 2,
              data: [{ type: "text", content: oversizedContent }],
            },
          },
          {
            id: "00000000-0000-4000-8000-000000000011",
            isTarget: true,
            role: "assistant",
            content: {
              version: 2,
              data: [{ type: "text", content: "not returned" }],
            },
          },
        ],
      },
    ]);

    const preview = await readSearchPreview({ ...previewQuery, type: "chat" });

    expect(preview).toMatchObject({
      type: "chat-messages",
      messages: [{ content: "a".repeat(15_988) }, { content: "not returned" }],
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

  test("retains the matching chat message when earlier context exhausts the cap", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: false,
            role: "user",
            content: {
              version: 2,
              data: [{ type: "text", content: "a".repeat(16_000) }],
            },
          },
          {
            id: "00000000-0000-4000-8000-000000000011",
            isTarget: true,
            role: "assistant",
            content: {
              version: 2,
              data: [{ type: "text", content: "matched message" }],
            },
          },
        ],
      },
    ]);

    expect(await readSearchPreview({ ...previewQuery, type: "chat" })).toEqual({
      type: "chat-messages",
      messages: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          role: "user",
          content: "a".repeat(15_985),
        },
        {
          id: "00000000-0000-4000-8000-000000000011",
          role: "assistant",
          content: "matched message",
        },
      ],
    });
  });

  test("retains a late match inside an oversized target message", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: true,
            role: "assistant",
            content: {
              version: 2,
              data: [
                {
                  type: "text",
                  content: `${"a".repeat(20_000)} résumé ${"b".repeat(1000)}`,
                },
              ],
            },
          },
        ],
      },
    ]);

    const preview = await readSearchPreview({
      ...previewQuery,
      query: "resume",
      type: "chat",
    });

    expect(preview).toMatchObject({
      type: "chat-messages",
      messages: [{ content: expect.stringContaining("résumé") }],
    });
    if (preview?.type === "chat-messages") {
      expect(preview.messages.at(0)?.content.length ?? 0).toBeLessThanOrEqual(
        16_000,
      );
    }
  });

  test("retains a late quoted phrase instead of an earlier standalone word", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: true,
            role: "assistant",
            content: {
              version: 2,
              data: [
                {
                  type: "text",
                  content: `closing ${"a".repeat(20_000)} closing, memo`,
                },
              ],
            },
          },
        ],
      },
    ]);

    const preview = await readSearchPreview({
      ...previewQuery,
      query: '"closing memo"',
      type: "chat",
    });

    expect(preview).toMatchObject({
      type: "chat-messages",
      messages: [{ content: expect.stringContaining("closing, memo") }],
    });
    if (preview?.type === "chat-messages") {
      expect(preview.messages.at(0)?.content).not.toStartWith("closing ");
    }
  });

  test("orders context around a first-position target without duplicates", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: true,
            role: "user",
            content: {
              version: 2,
              data: [{ type: "text", content: "target" }],
            },
          },
          {
            id: "00000000-0000-4000-8000-000000000011",
            isTarget: false,
            role: "assistant",
            content: { version: 2, data: [{ type: "text", content: "reply" }] },
          },
          {
            id: "00000000-0000-4000-8000-000000000012",
            isTarget: false,
            role: "user",
            content: {
              version: 2,
              data: [{ type: "text", content: "follow-up" }],
            },
          },
        ],
      },
    ]);

    expect(await readSearchPreview({ ...previewQuery, type: "chat" })).toEqual({
      type: "chat-messages",
      messages: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          role: "user",
          content: "target",
        },
        {
          id: "00000000-0000-4000-8000-000000000011",
          role: "assistant",
          content: "reply",
        },
        {
          id: "00000000-0000-4000-8000-000000000012",
          role: "user",
          content: "follow-up",
        },
      ],
    });
  });

  test("renders indexed source-document metadata in chat previews", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: true,
            role: "assistant",
            content: {
              version: 2,
              data: [],
              metadata: {
                sourceDocuments: [
                  {
                    title: "Closing memorandum",
                    mention: "@closing-memo",
                    entityRef: "entity_1",
                    matterRef: "matter_1",
                    kind: "document",
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(await readSearchPreview({ ...previewQuery, type: "chat" })).toEqual({
      type: "chat-messages",
      messages: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          role: "assistant",
          content: "Closing memorandum\n\n@closing-memo\n\ndocument",
        },
      ],
    });
  });

  test("normalizes legacy source-document metadata for chat previews", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: true,
            role: "assistant",
            content: {
              version: 1,
              data: [
                { type: "text", text: "The answer cites:" },
                {
                  type: "data-stella-source-document",
                  data: {
                    title: "Closing memorandum",
                    mention: "@closing-memo",
                    kind: "document",
                  },
                },
              ],
            },
          },
        ],
      },
    ]);

    expect(await readSearchPreview({ ...previewQuery, type: "chat" })).toEqual({
      type: "chat-messages",
      messages: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          role: "assistant",
          content:
            "The answer cites:\n\nClosing memorandum\n\n@closing-memo\n\ndocument",
        },
      ],
    });
  });

  test("returns a title preview when a chat thread has no matching messages", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        isTitleOnlyMatch: true,
        messages: [],
        title: "Closing memorandum review",
      },
    ]);

    expect(await readSearchPreview({ ...previewQuery, type: "chat" })).toEqual({
      type: "plain-text",
      content: "Closing memorandum review",
    });
  });

  test("keeps the selected message window for cross-message matches", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        isTitleOnlyMatch: false,
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: true,
            role: "user",
            content: {
              version: 2,
              data: [{ type: "text", content: "indemnity" }],
            },
          },
          {
            id: "00000000-0000-4000-8000-000000000011",
            isTarget: false,
            role: "assistant",
            content: {
              version: 2,
              data: [{ type: "text", content: "liability" }],
            },
          },
        ],
        title: "Unrelated title",
      },
    ]);

    expect(await readSearchPreview({ ...previewQuery, type: "chat" })).toEqual({
      type: "chat-messages",
      messages: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          role: "user",
          content: "indemnity",
        },
        {
          id: "00000000-0000-4000-8000-000000000011",
          role: "assistant",
          content: "liability",
        },
      ],
    });
  });

  test("skips malformed persisted chat parts", async () => {
    rootDbExecuteMock.mockResolvedValueOnce([
      {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000010",
            isTarget: true,
            role: "assistant",
            content: { version: 2, data: [null] },
          },
        ],
      },
    ]);

    expect(await readSearchPreview({ ...previewQuery, type: "chat" })).toEqual({
      type: "chat-messages",
      messages: [],
    });
  });
});
