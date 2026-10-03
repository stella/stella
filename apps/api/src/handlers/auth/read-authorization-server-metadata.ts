import { Result } from "better-result";

import { handleOAuthAuthorizationServerMetadataRequest } from "@/api/handlers/auth/metadata";
import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/demo-account-policy";

const readAuthorizationServerMetadata = createSafePublicHandler(
  {
    cache: { kind: "public", maxAge: 300 },
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
