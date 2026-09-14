// Fails the build when a shipped file links to a same-site URL the build did
// not write, or to a page without its trailing slash. Reads the rendered HTML
// and the shipped Markdown and text files, so links from components, content
// collections, Starlight, endpoints, and `public/` are all covered.
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
        const linking = [...files].filter((file) =>
          LINKING_EXTENSIONS.some((extension) => file.endsWith(extension)),
        );
        const documents = new Map(
          await Promise.all(
            linking.map(
              async (file) =>
                [file, await readFile(new URL(file, dir), "utf-8")] as const,
            ),
          ),
        );
        const issues = findLinkIssues({
          site:
            site ?? panic("internal-links needs `site` in the Astro config"),
          files,
          documents,
        });
        if (issues.length > 0) {
          panic(
            `${issues.length} internal link(s) do not resolve to a built page:\n${issues.map(describe).join("\n")}`,
          );
        }
        logger.info(`checked internal links in ${documents.size} files`);
      },
    },
  };
};

const LINKING_EXTENSIONS = [".html", ".md", ".txt"];

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
