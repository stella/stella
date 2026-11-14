import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";

import { listVariantsHandler } from "../variants";

const listVariantsParamsSchema = v.object({
  clauseId: resourceIdSchema("clause"),
});

const config = {
  contract: "patch",
  description:
    "List one clause's variants in sort order, each with its label, body, " +
    "and position. A clause that does not belong to this organization is a " +
    "404.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
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
