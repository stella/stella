import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "desktop-presence-observations",
  capability: "Reading and retaining desktop presence observations",
  owner: ["apps/api/src/handlers/desktop-presence/service.ts"],
  summary:
    "The service serializes reports against live membership and retains ten newest installations per organization and user. Offboarding clears observations in its membership transaction.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/schema", "@/api/db/schema/desktop-presence"],
    names: ["desktopPresence"],
    allowed: [
      {
        path: "apps/api/src/db/org-scope-registry.ts",
        reason:
          "Static row ownership and key metadata only; no data queries or mutations.",
      },
      {
        path: "apps/api/src/lib/member-offboarding/member-assignment-offboarding-census.ts",
        reason:
          "Static column metadata used only by the cleanup coverage test; no presence or assignment query.",
      },
      {
        path: "apps/api/src/lib/member-offboarding/member-assignment-offboarding-owner.ts",
        reason: "Clears observations during organization membership removal.",
      },
      {
        path: "apps/api/src/db/entity-feature-gate-repair.ts",
        reason:
          "Full-schema policy introspection: renders the entity feature policies the online cutover installs; reads no rows.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
