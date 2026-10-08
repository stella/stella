import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "operator-registration-directory",
  capability: "Serving audited operator registration pages",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "Reads bounded registration pages through the owner connection and records each read transactionally; callers receive only the declared directory fields, never a database handle.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["readOperatorRegistrationPage"],
    allowed: [
      {
        path: "apps/api/src/handlers/operator/registrations.ts",
        reason:
          "Authorizes the deployment credential before reading the directory.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
