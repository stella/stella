import { t } from "elysia";

import { DOCX_MIME_TYPE } from "@/api/handlers/docx/constants";
import { discoverTemplate } from "@/api/handlers/docx/discover-template";
import {
  mergeManifestWithDiscovery,
  readManifest,
} from "@/api/handlers/docx/template-manifest";
import type { SafeId } from "@/api/lib/branded-types";

export const discoverBodySchema = t.Object({
  file: t.File({ maxSize: "50m" }),
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
    conditions: manifest?.conditions ?? [],
    structureErrors: discovered.structureErrors,
  };
};
