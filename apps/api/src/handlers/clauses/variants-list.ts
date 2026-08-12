import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";

import { listVariantsHandler } from "./variants";

const listVariantsParamsSchema = t.Object({
  clauseId: tSafeId("clause"),
});

const config = {
  description:
    "List one clause's variants in sort order, each with its label, body, " +
    "and position. A clause that does not belong to this organization is a " +
    "404.",
  permissions: { workspace: ["read"] },
  mcp: { type: "covered", by: "list_clauses" },
  access: "read",
  params: listVariantsParamsSchema,
} satisfies HandlerConfig;

const listVariants = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params }) {
    return yield* listVariantsHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      clauseId: params.clauseId,
    });
  },
);

export default listVariants;
