import { tenantDecisionTableNames } from "@/api/lib/account-export/schema-census";

import { WITHDRAWN_COPY_REGISTRY } from "./withdrawn-copy-registry";

/** Require a projection for every schema-derived decision-associated store. */
export const unregisteredDecisionCopyStores = (
  tables?: Record<string, unknown>,
): string[] =>
  tenantDecisionTableNames(tables).filter(
    (name) => !Object.hasOwn(WITHDRAWN_COPY_REGISTRY, name),
  );
