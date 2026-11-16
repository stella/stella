import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "server-started-member",
  capability: "Building a member's request context without a request",
  owner: [
    "apps/api/src/lib/auth.ts",
    "apps/api/src/lib/chat/server-started-member.ts",
  ],
  summary:
    "A member context is built from a proved identity in one place, `resolveValidateAuth`. Besides the request resolvers in auth.ts, only chat work the server starts for a member (sending a message they queued) proves one, from a fresh membership lookup with no stored credential, so no other module can hand a handler a member nobody proved.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/auth"],
    names: ["resolveValidateAuth", "ResolvedIdentity"],
    allowed: [
      {
        path: "apps/api/src/lib/auth-member-caller.postgres.test.ts",
        reason:
          "Proves a context built from a session's identity equals the one the request path builds.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
