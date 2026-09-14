// Fails the build when a page links to a same-site URL the build did not
// write, or to a page without its trailing slash. Reads the rendered HTML, so
// hrefs from components, content collections, and Starlight are all covered.
import type { AstroIntegration } from "astro";
import { panic } from "better-result";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { findLinkIssues, type LinkIssue } from "../lib/internal-links";

export const internalLinks = (): AstroIntegration => {
  let site: URL | undefined;
  return {
    name: "internal-links",
    hooks: {
      "astro:config:done": ({ config }) => {
        site = config.site === undefined ? undefined : new URL(config.site);
      },
      "astro:build:done": async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const files = new Set(
          (await readdir(root, { recursive: true })).map((file) =>
            file.replaceAll("\\", "/"),
          ),
        );
        const htmlFiles = [...files].filter((file) => file.endsWith(".html"));
        const pages = new Map(
          await Promise.all(
            htmlFiles.map(
              async (file) =>
                [file, await readFile(new URL(file, dir), "utf-8")] as const,
            ),
          ),
        );
        const issues = findLinkIssues({
          site:
            site ?? panic("internal-links needs `site` in the Astro config"),
          files,
          pages,
        });
        if (issues.length > 0) {
          panic(
            `${issues.length} internal link(s) do not resolve to a built page:\n${issues.map(describe).join("\n")}`,
          );
        }
        logger.info(`checked internal links on ${pages.size} pages`);
      },
    },
  };
};

const describe = (issue: LinkIssue): string => {
  switch (issue.type) {
    case "missing-trailing-slash":
      return `  ${issue.page}: ${issue.href} (add the trailing slash)`;
    case "not-built":
      return `  ${issue.page}: ${issue.href} (no such page or file)`;
    default: {
      issue satisfies never;
      return panic(`Unhandled link issue: ${String(issue)}`);
    }
  }
};
