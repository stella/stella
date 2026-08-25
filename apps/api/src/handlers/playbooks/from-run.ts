/**
 * Keep what a review ran as a playbook.
 *
 * A reviewer with a past negotiated agreement and no written playbook confirms
 * a position list for one run; this is how that list stops being ephemeral.
 * The run's snapshot is copied verbatim, position ids included: a finding is
 * keyed by `positionId`, so preserving them is what lets the decision overlay
 * on the saved playbook see the runs that came before it.
 */

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { documentReviewRuns, entities } from "@/api/db/schema";
import { createPlaybookDefinitionHandler } from "@/api/handlers/playbooks/create-shared";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import type { ReviewPerspective } from "@/api/lib/document-review/contract";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { PlaybookScope } from "@/api/lib/workflow/playbook-positions";

const fromRunBodySchema = t.Object({
  workspaceId: tSafeId("workspace"),
  runId: tSafeId("documentReviewRun"),
  name: t.Optional(tDefaultVarchar),
});

const config = {
  description:
    "Save the position list a completed document review ran against as a new " +
    "draft playbook in the organization, taking the same create path a " +
    "hand-authored playbook takes (validation, the per-organization limit, " +
    "the draft status). Position ids are preserved, so decisions already " +
    "taken on those positions stay attached to them.",
  permissions: { playbook: ["create"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  body: fromRunBodySchema,
} satisfies HandlerConfig;

/**
 * Party roles that name a side of a sale unambiguously enough to pin the
 * playbook's perspective to it.
 *
 * A run's perspective is one of the target document's own parties ("the
 * Licensee", "the Landlord"); a playbook's scope perspective is the fixed
 * buyer/seller/neutral vocabulary the rest of the product grades by. There is
 * no general mapping between them, and guessing one wrong inverts every
 * favourable/unfavourable judgment a later run makes. So only the roles that
 * are a sale side by definition map; everything else leaves the scope
 * perspective unset for an author to choose.
 */
const SCOPE_PERSPECTIVE_BY_PARTY_ROLE: Record<string, "buyer" | "seller"> = {
  purchaser: "buyer",
  buyer: "buyer",
  seller: "seller",
  vendor: "seller",
};

const scopePerspectiveForRun = (
  perspective: ReviewPerspective,
): PlaybookScope["perspective"] => {
  switch (perspective.type) {
    case "neutral":
      return "neutral";
    case "party":
      return SCOPE_PERSPECTIVE_BY_PARTY_ROLE[
        perspective.role.trim().toLowerCase()
      ];
    default:
      perspective satisfies never;
      return undefined;
  }
};

/** `tDefaultVarchar` caps a playbook name at 256 characters, and a derived
 *  default is built from a document name that may itself be that long. */
const PLAYBOOK_NAME_MAX_LENGTH = 256;

const createPlaybookFromRun = createSafeRootHandler(
  config,
  async function* ({
    body: { name, runId, workspaceId },
    getWorkspaceAccess,
    orgAIConfig,
    promptCachingEnabled,
    recordAuditEvent,
    safeDb,
    session,
  }) {
    const organizationId = session.activeOrganizationId;

    // The matter is validated against the caller's memberships before the run
    // is read, and the read is then held to that matter and this organization:
    // a run in a matter the caller cannot open is indistinguishable from one
    // that does not exist.
    const workspace = yield* Result.await(
      Result.tryPromise(async () => await getWorkspaceAccess(workspaceId)),
    );
    const notFound = new HandlerError({
      status: 404,
      message: "Review run not found",
    });
    if (!workspace || workspace.status !== "active") {
      return Result.err(notFound);
    }

    const runs = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            status: documentReviewRuns.status,
            basis: documentReviewRuns.basis,
            // The reviewed document's current name, for the default playbook
            // name. Left-joined: a run outlives the document it judged.
            targetName: entities.name,
          })
          .from(documentReviewRuns)
          .leftJoin(
            entities,
            and(
              eq(entities.id, documentReviewRuns.entityId),
              eq(entities.workspaceId, documentReviewRuns.workspaceId),
            ),
          )
          .where(
            and(
              eq(documentReviewRuns.id, runId),
              eq(documentReviewRuns.workspaceId, workspace.id),
              eq(documentReviewRuns.organizationId, organizationId),
            ),
          )
          .limit(1),
      ),
    );
    const run = runs.at(0);
    if (run === undefined) {
      return Result.err(notFound);
    }
    // Only a finished review has a position list worth keeping: a queued or
    // failed run's snapshot was never actually exercised against a document.
    if (run.status !== "completed") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Only a completed review run can be saved as a playbook.",
        }),
      );
    }

    const { definitionSnapshot } = run.basis.playbook;
    if (definitionSnapshot.positions.items.length === 0) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "This review run has no positions to save.",
        }),
      );
    }

    const perspective = scopePerspectiveForRun(run.basis.perspective);
    const scope: PlaybookScope | undefined =
      perspective === undefined ? undefined : { perspective };
    const derivedName = `${run.targetName ?? definitionSnapshot.name} review`;

    const createdResult = yield* createPlaybookDefinitionHandler({
      safeDb,
      organizationId,
      orgAIConfig,
      promptCachingEnabled,
      recordAuditEvent,
      body: {
        name: name ?? derivedName.slice(0, PLAYBOOK_NAME_MAX_LENGTH),
        // Verbatim, ids and all: a fresh `sourceId` would cut the saved
        // playbook off from every decision already taken on these positions.
        positions: definitionSnapshot.positions,
        ...(scope === undefined ? {} : { scope }),
      },
      origin: { type: "authored" },
    });
    // The shared create path returns a Result of its own; an authored origin
    // never reports `existing`, so only the id reaches the caller.
    const created = yield* createdResult;

    return Result.ok({ id: created.id });
  },
);

export default createPlaybookFromRun;
