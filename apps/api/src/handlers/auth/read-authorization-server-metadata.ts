import { Result } from "better-result";

import { handleOAuthAuthorizationServerMetadataRequest } from "@/api/handlers/auth/metadata";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import { DISCOVERY_METADATA_CACHE_POLICY } from "@/api/lib/security-headers";

const readAuthorizationServerMetadata = createSafePublicHandler(
  {
    contract: "patch",
    cache: DISCOVERY_METADATA_CACHE_POLICY,
    // Any origin may read it; the answer carries its own CORS headers.
    cors: "own",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
  },
  async function* ({ request }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await handleOAuthAuthorizationServerMetadataRequest(request),
      ),
    );
    return Result.ok(response);
  },
);

export default readAuthorizationServerMetadata;
