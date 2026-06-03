import { createFileRoute } from "@tanstack/react-router";

import { createRobotsTxt } from "@/lib/public-law-sitemap";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(createRobotsTxt(), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }),
    },
  },
});
