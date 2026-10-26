import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { MCP_ALL_RESOURCE_SCOPES } from "@/api/mcp/constants";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import { handleMcpToolCall } from "@/api/mcp/tools";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * A mark is stored against a block anchor and offsets, and a parser change
 * that re-parses the corpus renumbers both. These calls run the real tools
 * against a real database: a mark is placed on one parse of a decision, the
 * decision is re-parsed, and the listing must name where the marked words are
 * now, or report the mark orphaned, and never hand back an anchor that names
 * other words.
 */

const paragraph = (anchorId: string, text: string): Block => ({
  anchorId,
  id: `id-${anchorId}`,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

// The publisher's hard-wrapped reasons, read as separate paragraphs.
const FIRST_PARSE = [
  paragraph("p-reasons-1", "Sąd rozważył"),
  paragraph("p-reasons-2", "przepisy ustawy."),
  paragraph("p-reasons-3", "Skarga została oddalona."),
  paragraph(
    "p-reasons-4",
    "Na podstawie art. 5 ustawy sąd oddalił skargę w całości.",
  ),
  paragraph(
    "p-reasons-5",
    "Na podstawie art. 5 ustawy organ umorzył postępowanie.",
  ),
  paragraph("p-reasons-6", "Wyrok jest prawomocny."),
];

// Re-parsed: the wrapped first two lines join into one paragraph, which
// renumbers every anchor after it, and a closing sentence is no longer
// part of the decision's text.
const SECOND_PARSE = [
  paragraph("p-reasons-1", "Sąd rozważył przepisy ustawy."),
  paragraph("p-reasons-2", "Skarga została oddalona."),
  paragraph(
    "p-reasons-3",
    "Na podstawie art. 5 ustawy sąd oddalił skargę w całości.",
  ),
  paragraph(
    "p-reasons-4",
    "Na podstawie art. 5 ustawy organ umorzył postępowanie.",
  ),
];

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

type Caller = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const createCaller = async (): Promise<Caller> => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await testDb
    .insert(user)
    .values({ id: userId, name: "Reader", email: `${userId}@example.test` });
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Firm",
    slug: `firm-${organizationId}`,
    createdAt: new Date(),
  });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  return { organizationId, userId };
};

/** One MCP request against the given parse of the decision. */
const requestContext = (
  { organizationId, userId }: Caller,
  blocks: readonly Block[],
): AuthorizedMcpRequestContext => {
  const identity = { organizationId, serverValidatedWorkspaceIds: [], userId };
  return asTestRaw<AuthorizedMcpRequestContext>({
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    grantedScopes: MCP_ALL_RESOURCE_SCOPES,
    memberRole: "owner",
    organizationId,
    recordAuditEvent: async () => undefined,
    safeDb: asTestRaw<SafeDb>(createMembershipSafeDb(testDb, identity)),
    scopedDb: asTestRaw<ScopedDb>(createMembershipScopedDb(testDb, identity)),
    toolConfirmation: TOOL_CONFIRMATION.caller,
    userId,
    userEmail: "reader@example.test",
    testDependencies: {
      // The corpus gate has its own tests; here the decision is open to the
      // agent, in whichever parse the step reads.
      resolveAnnotationTarget: async () =>
        await Promise.resolve({
          status: "available" as const,
          readBlocks: async () => await Promise.resolve(blocks),
        }),
    },
  });
};

type ListedPayload = {
  annotations: { passages: Record<string, unknown>[] }[];
};

const payloadOf = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
): ListedPayload => {
  const item = result.content.at(0);
  // The response text names a failing call.
  expect({
    isError: result.isError === true,
    response: item?.type === "text" ? item.text : null,
  }).toMatchObject({ isError: false });
  return asTestRaw<ListedPayload>(result.structuredContent);
};

const DECISION_ID = "00000000-0000-4000-8000-0000000d0001";

const mark = async (
  caller: Caller,
  passage: { anchor: string; quote: string },
) =>
  payloadOf(
    await handleMcpToolCall({
      mode: "advanced",
      toolName: "create_reader_annotation",
      context: requestContext(caller, FIRST_PARSE),
      args: {
        target_type: "decision",
        target_id: DECISION_ID,
        mark: { kind: "highlight" },
        passages: [passage],
      },
    }),
  );

const listAfterReparse = async (caller: Caller, blocks: readonly Block[]) =>
  payloadOf(
    await handleMcpToolCall({
      mode: "advanced",
      toolName: "list_reader_annotations",
      context: requestContext(caller, blocks),
      args: { target_type: "decision", target_id: DECISION_ID },
    }),
  );

describe("reader marks across a re-parse of their decision", () => {
  test("each mark names where its words are now, or is orphaned", async () => {
    const caller = await createCaller();
    await mark(caller, { anchor: "p-reasons-2", quote: "przepisy ustawy." });
    await mark(caller, { anchor: "p-reasons-3", quote: "oddalona" });
    // The same words in two paragraphs: the text around them decides.
    await mark(caller, { anchor: "p-reasons-5", quote: "art. 5 ustawy" });
    await mark(caller, { anchor: "p-reasons-6", quote: "prawomocny" });

    // Unchanged text: every mark is where it was made.
    expect(
      (await listAfterReparse(caller, FIRST_PARSE)).annotations.map(
        (listed) => listed.passages,
      ),
    ).toEqual([
      [
        {
          placement: "placed",
          anchor: "p-reasons-2",
          quote: "przepisy ustawy.",
        },
      ],
      [{ placement: "placed", anchor: "p-reasons-3", quote: "oddalona" }],
      [{ placement: "placed", anchor: "p-reasons-5", quote: "art. 5 ustawy" }],
      [{ placement: "placed", anchor: "p-reasons-6", quote: "prawomocny" }],
    ]);

    const listed = await listAfterReparse(caller, SECOND_PARSE);
    expect(listed.annotations.map((entry) => entry.passages)).toEqual([
      // The stored `p-reasons-2` now names "Skarga została oddalona.".
      [
        {
          placement: "placed",
          anchor: "p-reasons-1",
          quote: "przepisy ustawy.",
        },
      ],
      [{ placement: "placed", anchor: "p-reasons-2", quote: "oddalona" }],
      // The stored `p-reasons-5` is gone; the twin in `p-reasons-3` is
      // followed by other words, so the mark goes to `p-reasons-4`.
      [{ placement: "placed", anchor: "p-reasons-4", quote: "art. 5 ustawy" }],
      [
        {
          placement: "orphaned",
          reason: "quote_not_found",
          quote: "prawomocny",
        },
      ],
    ]);
  });

  test("a quote the new text repeats with nothing to tell it apart is orphaned", async () => {
    const caller = await createCaller();
    await mark(caller, { anchor: "p-reasons-2", quote: "przepisy ustawy." });

    const listed = await listAfterReparse(caller, [
      paragraph("p-1", "przepisy ustawy."),
      paragraph("p-2", "Wstęp"),
      paragraph("p-3", "przepisy ustawy."),
    ]);

    expect(listed.annotations.at(0)?.passages).toEqual([
      {
        placement: "orphaned",
        reason: "quote_ambiguous",
        quote: "przepisy ustawy.",
      },
    ]);
  });
});
