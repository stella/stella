import { Result } from "better-result";

import {
  AGENT_AUTH_MANIFEST_HEADERS,
  getAgentAuthManifest,
} from "@/api/agent-auth/manifest";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";

const readManifest = createSafePublicHandler(
  {
    cache: { kind: "public", maxAge: 300 },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
  },
  async function* ({ set }) {
    for (const [key, value] of Object.entries(AGENT_AUTH_MANIFEST_HEADERS)) {
      set.headers[key] = value;
    }
    const manifest = yield* Result.await(
      Promise.resolve(Result.try(getAgentAuthManifest)),
    );
    return Result.ok(manifest);
  },
);

export default readManifest;
