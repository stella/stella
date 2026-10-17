import { Result } from "better-result";

import { handleOAuthAuthorizationServerMetadataRequest } from "@/api/handlers/auth/metadata";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import { DISCOVERY_DOCUMENT_CACHE } from "@/api/lib/auth/auth-paths";
import { dropOriginBoundCors } from "@/api/lib/public-cors";

const readAuthorizationServerMetadata = createSafePublicHandler(
  {
    contract: "patch",
    cache: DISCOVERY_DOCUMENT_CACHE,
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
  },
  async function* ({ request, set }) {
    dropOriginBoundCors(set);
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
