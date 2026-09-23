import { describe, expect, test } from "bun:test";

import {
  collectMessageWorkspaceIds,
  planThreadScopeAdditions,
} from "@/api/handlers/chat/recompute-thread-scope";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";

const orgA = toSafeId<"organization">("00000000-0000-0000-0000-0000000000a1");
const orgB = toSafeId<"organization">("00000000-0000-0000-0000-0000000000b1");
const wsA = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000a");
const wsB = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000b");
const wsForeign = toSafeId<"workspace">("00000000-0000-0000-0000-00000000000f");
const threadId = toSafeId<"chatThread">("00000000-0000-0000-0000-0000000000aa");

const messages = [
  {
    id: "user-1",
    role: "user",
    parts: [
      {
        type: "text",
        content: `Compare with [Matter A](#stella-workspace=${wsA}).`,
      },
    ],
  },
  {
    id: "assistant-1",
    role: "assistant",
    parts: [],
    metadata: {
      sourceDocuments: [
        {
          entityId: "00000000-0000-0000-0000-000000000002",
          kind: "document",
          mimeType: "application/pdf",
          title: "Motion.pdf",
          workspaceId: wsB,
        },
        {
          entityId: "00000000-0000-0000-0000-000000000003",
          kind: "document",
          mimeType: "application/pdf",
          title: "Other.pdf",
          workspaceId: wsForeign,
        },
      ],
    },
  },
] satisfies ChatMessage[];

const messagesByThreadId = new Map([[threadId, messages]]);
const workspaceOrganizationById = new Map<string, string>([
  [wsA, orgA],
  [wsB, orgA],
  [wsForeign, orgB],
]);

describe("planThreadScopeAdditions", () => {
  test("adds the workspaces the stored messages carry", () => {
    expect(
      planThreadScopeAdditions({
        messagesByThreadId,
        threads: [{ id: threadId, organizationId: orgA, dataWorkspaceIds: [] }],
        workspaceOrganizationById,
      }),
    ).toEqual([{ threadId, organizationId: orgA, additions: [wsA, wsB] }]);
  });

  test("never removes stored scope and skips threads already covered", () => {
    expect(
      planThreadScopeAdditions({
        messagesByThreadId,
        threads: [
          { id: threadId, organizationId: orgA, dataWorkspaceIds: [wsA, wsB] },
        ],
        workspaceOrganizationById,
      }),
    ).toEqual([]);
  });

  test("ignores ids that are not workspaces of the thread's organization", () => {
    const planned = planThreadScopeAdditions({
      messagesByThreadId,
      threads: [
        { id: threadId, organizationId: orgA, dataWorkspaceIds: [wsA] },
      ],
      workspaceOrganizationById,
    });

    expect(planned.flatMap(({ additions }) => additions)).toEqual([wsB]);
  });

  test("collects every carried id for the organization lookup", () => {
    expect(new Set(collectMessageWorkspaceIds(messagesByThreadId))).toEqual(
      new Set([wsA, wsB, wsForeign]),
    );
  });
});
