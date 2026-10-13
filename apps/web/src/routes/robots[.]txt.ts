import { createFileRoute } from "@tanstack/react-router";

import { CONTACT_EMAIL } from "@/lib/consts";
import { createRobotsTxt } from "@/lib/public-law-sitemap";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          `# Automated scraping, bulk download and AI training on stella are not permitted.\n# Interested in our data? We license it: ${CONTACT_EMAIL}\n${createRobotsTxt()}`,
          {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
            },
          },
        ),
    },
  },
});
