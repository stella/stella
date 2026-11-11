/**
 * A list's verification graph: the documents verified against it, their
 * claims, the list's facts and the documents those facts come from, linked
 * as the stored runs, review events and fact sources link them. Read-only
 * and never stored, so it cannot drift from the review it draws.
 */

import { panic, Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import {
  readVerificationGraph,
  verificationGraphCursor,
} from "@/api/lib/lists/verification/graph-read";
import { recordVerificationReads } from "@/api/lib/lists/verification/read-audit";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

const config = {
  contract: "patch",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  description:
    "Read the verification graph of one list: every document verified " +
    "against it (`statements`, the latest finished verification of each), " +
    "their claims with the verdict as reviewers see it now (a re-check " +
    "counts, a governed record conflict takes the governing record's " +
    "verdict), the review status and qualifiers, the list's facts (`held` " +
    "when kept out of scoring, `tier`: `document`, `testimony` or " +
    "`unsourced`; a fact off the list that a claim still cites has `listed` " +
    "false), and the documents the facts come from (`sources`). " +
    "`citations` links a claim to each fact it rests on: `cites` with the " +
    "relation its grade gives (`supports`, `conflicts`, `record`), or " +
    "`record-conflict` for each of the two records a withheld verdict sits " +
    "between. `provenance` links a fact to a source document at its " +
    "locator. Paginated by documents with a cursor; a document with more " +
    "claims than `limit` continues on the next page. Every page carries " +
    "the list's facts.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "document_processing",
    consumesServices: false,
  },
  params: workspaceParams({}),
  query: v.object({
    listId: resourceIdSchema("legalList"),
    cursor: v.optional(paginationCursorSchema()),
    limit: v.optional(
      numberFromString(
        paginationLimitSchema(VERIFICATION_LIMITS.GRAPH_CLAIMS_PAGE_MAX),
      ),
    ),
  }),
} satisfies WorkspaceHandlerConfig;

const readVerificationGraphHandler = createSafeHandler(
  config,
  async function* ({
    query: { listId, cursor, limit },
    safeDb,
    session,
    user,
    workspaceId,
    recordAuditEvent,
  }) {
    // An empty cursor is a first page, as a client that forwards an unset
    // cursor sends it; any other value must be one this route issued.
    const decodedCursor =
      cursor === undefined || cursor === ""
        ? null
        : verificationGraphCursor.decode(cursor);
    if (decodedCursor === null && cursor !== undefined && cursor !== "") {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_cursor",
          message: "Invalid cursor",
        }),
      );
    }
    const pageLimit = normalizeTenantPageLimit(
      limit ?? VERIFICATION_LIMITS.GRAPH_CLAIMS_PAGE_MAX,
    );

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const read = await readVerificationGraph({
          tx,
          workspaceId,
          listId,
          cursor: decodedCursor,
          limit: pageLimit,
        });
        if (read.type === "read") {
          // The page delivers the claims of these runs, as their point read
          // does, so it is audited the same way.
          await recordVerificationReads({
            tx,
            runs: read.runs,
            organizationId: session.activeOrganizationId,
            workspaceId,
            userId: user.id,
            recordAuditEvent,
          });
        }
        return read;
      }),
    );

    switch (outcome.type) {
      case "list-not-found": {
        return Result.err(
          new HandlerError({
            status: 404,
            code: "list_not_found",
            message: "List not found",
          }),
        );
      }
      case "read": {
        return Result.ok(outcome.graph);
      }
      default: {
        outcome satisfies never;
        return panic(`Unhandled outcome: ${String(outcome)}`);
      }
    }
  },
);

export default readVerificationGraphHandler;
