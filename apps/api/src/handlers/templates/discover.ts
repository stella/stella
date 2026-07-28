import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { manifestNamedConditions } from "@/api/lib/docx/manifest-conditions";
import {
  mergeManifestWithDiscovery,
  readManifest,
} from "@/api/lib/docx/template-manifest";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const discoverBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

type DiscoverProps = {
  organizationId: SafeId<"organization">;
  body: { file: File };
};

export const discoverHandler = async ({ body: { file } }: DiscoverProps) => {
  if (file.type !== DOCX_MIME_TYPE) {
    return new Response(
      JSON.stringify({
        error: "Invalid file type. Expected a DOCX file.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  const [discovered, manifest] = await Promise.all([
    discoverTemplate(buffer),
    readManifest(buffer),
  ]);

  const fields = mergeManifestWithDiscovery(manifest, discovered);

  return {
    fields,
    conditions: manifest ? manifestNamedConditions(manifest) : [],
    structureErrors: discovered.structureErrors,
  };
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  access: "read",
  body: discoverBodySchema,
} satisfies HandlerConfig;

const discoverTemplateHandler = createSafeRootHandler(
  config,
  async function* ({ session, body }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await discoverHandler({
            organizationId: session.activeOrganizationId,
            body,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Internal server error",
            cause,
          }),
      }),
    );
    return Result.ok(result);
  },
);

export default discoverTemplateHandler;
