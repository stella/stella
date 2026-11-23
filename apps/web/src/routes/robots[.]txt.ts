import { createFileRoute } from "@tanstack/react-router";

import { CONTACT_EMAIL } from "@/lib/consts";
import { createRobotsTxt } from "@/lib/public-law-sitemap";
import { ssrCacheClassHeaders } from "@/route-response-policy";

/**
 * robots.txt is the same for every viewer, so a shared cache may keep it and
 * serve the last good copy for a week while the origin fails: a crawler that
 * meets an erroring robots.txt treats the whole site as off-limits.
 */
const ROBOTS_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=604800";

export const robotsHandlers = {
  GET: () =>
    new Response(
      `# Automated scraping, bulk download and AI training on stella are not permitted.\n# Interested in our data? We license it: ${CONTACT_EMAIL}\n${createRobotsTxt()}`,
      {
        headers: {
          ...ssrCacheClassHeaders("public-anonymous"),
          "Cache-Control": ROBOTS_CACHE_CONTROL,
          "Content-Type": "text/plain; charset=utf-8",
        },
      },
    ),
};

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: robotsHandlers,
  },
});
