import { createFileRoute } from "@tanstack/react-router";
import JSZip from "jszip";

import { loadCatalogue } from "@stll/catalogue";
import { findCatalogueSkillInstallPayload } from "@stll/catalogue/install-payloads";

import { isPublicToolsRouteEnabled } from "@/lib/public-tools-launch";

const notFound = () => new Response("Not Found", { status: 404 });

// Zips are built from the static in-tree install-payload bundle: no
// session, no DB, no org data. Github-sourced skills have no in-tree
// bytes to zip, so they 404 here and link to the upstream archive.
export const Route = createFileRoute("/tools/$slug_/download")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!isPublicToolsRouteEnabled()) {
          return notFound();
        }

        const entry = loadCatalogue().find((e) => e.slug === params.slug);
        if (!entry || entry.kind !== "skill" || entry.source !== "in-tree") {
          return notFound();
        }

        const payload = findCatalogueSkillInstallPayload(params.slug);
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
            "Cache-Control": "public, max-age=3600",
            "Content-Disposition": `attachment; filename="${params.slug}.zip"`,
            "Content-Type": "application/zip",
          },
        });
      },
    },
  },
});
