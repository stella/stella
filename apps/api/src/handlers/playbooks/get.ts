import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
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
  mcp: { type: "covered", by: "list_playbooks" },
  access: "read",
  params: playbookDefinitionParamsSchema,
} satisfies HandlerConfig;

const getPlaybookDefinition = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
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

    // The documents this reader can open among the positions' sources, with
    // the names the stored positions deliberately omit. The positions keep
    // every source pair, so the editor's full-replace save round-trips the
    // ones this reader cannot resolve; the shared read stays unfiltered
    // because `save_playbook` merges against the stored truth.
    const readableSources = yield* Result.await(
      readablePositionSources(
        safeDb,
        positionSourceEntityIds(positionSources(playbook.positions.items)),
      ),
    );

    return Result.ok({
      ...playbook,
      positionDecisions,
      positionSources: readableSources,
    });
  },
);

export default getPlaybookDefinition;
