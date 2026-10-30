import { globalSystemWorkAllowedImports } from "../global-system-work-census.ts";
import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "global-system-work",
  capability: "Running narrowly declared tenantless system work",
  owner: ["apps/api/src/lib/db/global-system-work.ts"],
  summary:
    "The system database door accepts closed literal intents for its listed cleanup jobs; each intent is callable only from its source owner.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/db/global-system-work"],
    names: ["runGlobalSystemWork"],
    allowed: globalSystemWorkAllowedImports(),
  },
} as const satisfies OwnershipEntry;
