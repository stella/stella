import { loadCatalogue } from "@stll/catalogue";
import { findCatalogueSkillInstallPayload } from "@stll/catalogue/install-payloads";
import { ZipArchive } from "@stll/docx-core/zip";
import {
  buildSkillPackage,
  SKILL_PACKAGE_FILE_TYPES,
  skillPackageFileName,
} from "@stll/skills/package";

import { ssrCacheClassHeaders } from "@/route-response-policy";

const notFound = () => new Response("Not Found", { status: 404 });

/**
 * A published skill as a skill package zip, the same layout an export from
 * a workspace has. Built from the static in-tree install-payload bundle: no
 * session, no DB, no org data. Github-sourced skills have no in-tree bytes
 * to zip, so they 404 here and link to the upstream archive.
 */
export const publicToolDownloadResponse = async (
  slug: string,
): Promise<Response> => {
  const entry = loadCatalogue().find((e) => e.slug === slug);
  if (!entry || entry.kind !== "skill" || entry.source !== "in-tree") {
    return notFound();
  }

  const payload = findCatalogueSkillInstallPayload(slug);
  if (!payload) {
    return notFound();
  }

  const encoder = new TextEncoder();
  const zip = new ZipArchive();
  for (const file of buildSkillPackage({
    command: null,
    displayName: entry.displayName,
    resources: payload.resourceFiles.map((resource) => ({
      bytes: encoder.encode(resource.content),
      path: resource.path,
    })),
    skillMd: payload.body,
    slug,
  })) {
    zip.set(file.path, file.bytes);
  }
  const bytes = (await zip.generate({ compression: "store" })).buffer;

  return new Response(bytes, {
    headers: {
      ...ssrCacheClassHeaders("public-anonymous"),
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": `attachment; filename="${skillPackageFileName(slug, "zip")}"`,
      "Content-Type": SKILL_PACKAGE_FILE_TYPES.zip.mediaType,
    },
  });
};

export const publicToolNotFoundResponse = notFound;
