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
        path: "apps/api/src/lib/member-assignment-offboarding.ts",
        reason: "Clears observations during organization membership removal.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
