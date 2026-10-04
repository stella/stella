import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readPositionDecisionOverlay } from "@/api/lib/document-review/position-decisions";
import {
  positionSourceEntityIds,
  positionSources,
  readablePositionSources,
} from "@/api/lib/workflow/playbook-position-sources";

import { getPlaybookDefinitionHandler } from "./read";
import { playbookDefinitionParamsSchema } from "./schema";

const config = {
  description:
    "Read one playbook definition in full: its name, description, " +
    "document-type scope, positions, status, approval metadata, and how the " +
    "organization has decided each position across past reviews. " +
    "positionSources names the source documents of its positions that the " +
    "caller can open. Use " +
    "playbooks.list for the paginated overview.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "covered", by: "list_playbooks" },
  access: "read",
  params: playbookDefinitionParamsSchema,
} satisfies HandlerConfig;

const getPlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, getActiveWorkspaceIds }) {
    const organizationId = session.activeOrganizationId;
    // The shared read returns a Result of its own; unwrap it so a 404 short-
    // circuits before the overlay query.
    const playbookResult = yield* getPlaybookDefinitionHandler({
      safeDb,
      organizationId,
      playbookId: params.playbookId,
    });
    const playbook = yield* playbookResult;

    // What the organization has actually done with each of these positions,
    // across every run that graded one. Derived from the findings, so an
    // editor can show that a position it still calls a red line has been
    // dismissed in every review that raised it. Deliberately here rather than
    // in the shared read: it answers an authoring question, and the MCP
    // playbook projection has no use for it.
    const positionDecisions = yield* Result.await(
      safeDb(
        async (tx) =>
          await readPositionDecisionOverlay({
            tx,
            organizationId,
            positionIds: playbook.positions.items.map(
              (position) => position.sourceId,
            ),
          }),
      ),
    );

    // Look up the names of the source documents this caller can open; stored
    // positions hold ids only. The returned positions still include every
    // source id, even for documents this caller cannot open, because the
    // editor saves the whole position list and would otherwise delete them.
    // The shared read above is not filtered either: `save_playbook` merges
    // against the full stored list. The caller's matters are fetched only
    // when the playbook has at least one source.
    const sourceEntityIds = positionSourceEntityIds(
      positionSources(playbook.positions.items),
    );
    const readableSources =
      sourceEntityIds.length === 0
        ? []
        : yield* Result.await(
            readablePositionSources({
              safeDb,
              entityIds: sourceEntityIds,
              accessibleWorkspaceIds: yield* Result.await(
                Result.tryPromise(async () => await getActiveWorkspaceIds()),
              ),
            }),
          );

    return Result.ok({
      ...playbook,
      positionDecisions,
      positionSources: readableSources,
    });
  },
);

export default getPlaybookDefinition;
