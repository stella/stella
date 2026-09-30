import { Result } from "better-result";

import { createSafePublicHandler } from "@/api/lib/api-handlers";
import { buildMcpClientMetadataDocument } from "@/api/lib/mcp-upstream/oauth";

const readClientMetadata = createSafePublicHandler(
  {
    cache: { kind: "public", maxAge: 3600 },
    mcp: { type: "internal", reason: "auth_plumbing" },
  },
  async function* () {
    const metadata = yield* Result.await(
      Promise.resolve(Result.try(buildMcpClientMetadataDocument)),
    );
    return Result.ok(metadata);
  },
);

export default readClientMetadata;
