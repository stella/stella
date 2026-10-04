import { panic, Result } from "better-result";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { deriveManifest } from "@/api/lib/docx/derived-manifest";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { manifestNamedConditions } from "@/api/lib/docx/manifest-conditions";
import { mergeManifestWithDiscovery } from "@/api/lib/docx/template-manifest";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { scanTemplateUpload } from "@/api/lib/templates/scan-template-upload";
import {
  discoverTemplateSource,
  loadStoredTemplateSource,
} from "@/api/lib/templates/template-fill-service";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const discoverBodySchema = t.Object({
  file: t.Optional(t.File({ maxSize: FILE_SIZE_LIMITS.document })),
  templateId: t.Optional(tSafeId("template")),
});

type DiscoverProps = {
  organizationId: SafeId<"organization">;
  body: {
    file?: File | undefined;
    templateId?: SafeId<"template"> | undefined;
  };
  scopedDb?: ScopedDb | undefined;
};

type DiscoverResult = Result<
  {
    fields: ReturnType<typeof mergeManifestWithDiscovery>;
    conditions: ReturnType<typeof manifestNamedConditions>;
    structureErrors: Awaited<
      ReturnType<typeof discoverTemplate>
    >["structureErrors"];
  },
  HandlerError
>;

export const discoverHandler = async ({
  organizationId,
  scopedDb,
  body: { file, templateId },
}: DiscoverProps): Promise<DiscoverResult> => {
  if (templateId !== undefined) {
    if (scopedDb === undefined) {
      panic("Stored template discovery requires scopedDb");
    }
    const loaded = await loadStoredTemplateSource({
      templateId,
      organizationId,
      scopedDb,
    });
    if (Result.isError(loaded)) {
      return Result.err(loaded.error);
    }
    const { discovered, manifest } = await discoverTemplateSource({
      source: loaded.value,
      organizationId,
      scopedDb,
    });
    return Result.ok({
      fields: mergeManifestWithDiscovery(manifest, discovered),
      conditions: manifestNamedConditions(manifest),
      structureErrors: discovered.structureErrors,
    });
  }
  if (file === undefined) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "A file or templateId is required",
      }),
    );
  }
  if (file.type !== DOCX_MIME_TYPE) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid file type. Expected a DOCX file.",
      }),
    );
  }

  const scanned = await scanTemplateUpload(file);
  if (Result.isError(scanned)) {
    return Result.err(scanned.error);
  }

  const discovered = await discoverTemplate(scanned.value);
  const manifest = deriveManifest(discovered);

  return Result.ok({
    fields: mergeManifestWithDiscovery(manifest, discovered),
    conditions: manifestNamedConditions(manifest),
    structureErrors: discovered.structureErrors,
  });
};

const config = {
  contentDelivery: {
    type: "none",
    reason:
      "Processes template content and returns parsed data or saved-document metadata rather than stored-file bytes.",
  },
  description:
    "Inspect DOCX fields, marker configuration, named conditions and structural errors. " +
    "With templateId, resolve the stored template and linked clauses; otherwise inspect uploaded bytes. Stores nothing.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  access: "read",
  transport: {
    type: "file-input",
    input: { field: "file", required: false, mediaTypes: [DOCX_MIME_TYPE] },
    alternative: {
      type: "partial",
      via: ["templates.get"],
      limitation:
        "returns the discovered fields of a template already stored; it cannot inspect a newly supplied DOCX",
    },
  },
  body: discoverBodySchema,
} satisfies HandlerConfig;

const discoverTemplateHandler = createSafeRootHandler(
  config,
  async function* ({ session, scopedDb, body }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await discoverHandler({
            organizationId: session.activeOrganizationId,
            body,
            scopedDb,
          }),
        catch: (cause) =>
          cause instanceof HandlerError
            ? cause
            : new HandlerError({
                status: 500,
                message: "Internal server error",
                cause,
              }),
      }),
    );
    return result;
  },
);

export default discoverTemplateHandler;
