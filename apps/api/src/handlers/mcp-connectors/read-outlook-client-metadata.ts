import { Result } from "better-result";

import {
  nativeClientMetadataResponseSchema,
  toNativeClientMetadataResponse,
} from "@/api/handlers/mcp-connectors/native-client-metadata-response";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { getOutlookClientMetadataDocument } from "@/api/lib/auth/oauth-own-client-documents";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readOutlookClientMetadata = createSafeBoundedPublicHandler(
  {
    contract: "patch",
    cache: { kind: "public", maxAge: 3600 },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
    response: safePublicHandlerResponseSchemasWithStatusText(
      nativeClientMetadataResponseSchema,
    ),
  },
  async function* () {
    const found = getOutlookClientMetadataDocument();
    const document = yield* Result.await(
      Promise.resolve(
        found
          ? Result.ok(found)
          : Result.err(
              new HandlerError({
                status: 404,
                code: "not_found",
                message:
                  "This deployment does not configure the Outlook add-in",
              }),
            ),
      ),
    );
    return Result.ok(toNativeClientMetadataResponse(document));
  },
);

export default readOutlookClientMetadata;
