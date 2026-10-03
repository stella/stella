import { Result } from "better-result";

import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { getCliClientMetadataDocument } from "@/api/lib/auth/oauth-own-client-documents";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readCliClientMetadata = createSafePublicHandler(
  {
    cache: { kind: "public", maxAge: 3600 },
    mcp: { type: "internal", reason: "auth_plumbing" },
  },
  async function* () {
    const found = getCliClientMetadataDocument();
    const document = yield* Result.await(
      Promise.resolve(
        found
          ? Result.ok(found)
          : Result.err(new HandlerError({ status: 404, message: "Not found" })),
      ),
    );
    return Result.ok(document);
  },
);

export default readCliClientMetadata;
