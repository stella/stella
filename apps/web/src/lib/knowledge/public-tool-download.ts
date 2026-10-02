import JSZip from "jszip";

import { loadCatalogue } from "@stll/catalogue";
import { findCatalogueSkillInstallPayload } from "@stll/catalogue/install-payloads";

import { ssrCacheClassHeaders } from "@/route-response-policy";

const notFound = () => new Response("Not Found", { status: 404 });

/**
 * A published skill as a zip. Built from the static in-tree install-payload
 * bundle: no session, no DB, no org data. Github-sourced skills have no
 * in-tree bytes to zip, so they 404 here and link to the upstream archive.
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

  const zip = new JSZip();
  zip.file("SKILL.md", payload.body);
  for (const resource of payload.resourceFiles) {
    zip.file(resource.path, resource.content);
  }
  const bytes = await zip.generateAsync({ type: "arraybuffer" });

  return new Response(bytes, {
    headers: {
      ...ssrCacheClassHeaders("public-anonymous"),
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      "Content-Type": "application/zip",
    },
  });
};

export const publicToolNotFoundResponse = notFound;
