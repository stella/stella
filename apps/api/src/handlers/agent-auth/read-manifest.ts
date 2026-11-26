import { Result } from "better-result";
import * as v from "valibot";

import {
  AGENT_AUTH_MANIFEST_HEADERS,
  getAgentAuthManifest,
} from "@/api/agent-auth/manifest";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";

const manifestResponseSchema = v.pipe(v.string(), v.maxLength(16_384));

const readManifest = createSafePublicHandler(
  {
    contract: "patch",
    cache: { kind: "public", maxAge: 300 },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
    response: safePublicHandlerResponseSchemasWithStatusText(
      manifestResponseSchema,
    ),
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
