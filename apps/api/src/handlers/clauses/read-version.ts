import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { getClauseVersionHandler } from "./read";

const getClauseVersionParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
  versionId: tSafeId("clauseVersion"),
});

const config = {
  description:
    "Read the stored body of one specific clause version, with its version " +
    "number and creation time. Use clauses.get for the clause's current body " +
    "and its version list, and clauses.versions-restore to bring an old " +
    "version back into use.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_clauses" },
  access: "read",
  params: getClauseVersionParamsSchema,
} satisfies HandlerConfig;

const getClauseVersion = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* getClauseVersionHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
      versionId: params.versionId,
    });
  },
);

export default getClauseVersion;
