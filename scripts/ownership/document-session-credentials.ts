import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "document-session-credentials",
  capability: "Issuing opaque document session credentials",
  owner: ["apps/api/src/lib/entities/opaque-tokens.ts"],
  summary:
    "Document credential owners apply the principal policy before issuing a token. Collaboration credentials also retain their source session.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/entities/opaque-tokens"],
    names: ["createOpaqueToken"],
    allowed: [
      {
        path: "apps/api/src/lib/folio-collab-rooms.ts",
        reason: "Binds monitoring room credentials to a live source session.",
      },
      {
        path: "apps/api/src/lib/desktop-edit-sessions.ts",
        reason:
          "Applies the credential policy to desktop sessions and handoffs.",
      },
      {
        path: "apps/api/src/lib/files/pdf-signing/sessions.ts",
        reason:
          "Applies the credential policy to signing sessions and handoffs.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
