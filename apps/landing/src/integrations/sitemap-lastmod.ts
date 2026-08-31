// Gives every sitemap entry a truthful <lastmod>: the newest commit that
// touched the sources a page renders from. A build without history (a
// shallow checkout) emits no <lastmod> at all rather than stamping today's
// date on 134 unchanged pages, which crawlers learn to ignore.
import type { AstroIntegration } from "astro";
import { panic } from "better-result";
import { spawnSync } from "node:child_process";

const SRC = "apps/landing/src";
const MESSAGES = `${SRC}/i18n/messages`;
const DOCS = `${SRC}/content/docs/docs`;
const BLOG = `${SRC}/content/blog`;
const CHANGELOG = "docs/changelog";

// A trailing slash marks a directory: any file below it counts.
// Release notes and their dates feed both the changelog page and the
// homepage's latest-release badge and grid (src/lib/changelog.ts).
const CHANGELOG_SOURCES = [
  `${SRC}/data/changelog-release-dates.json`,
  `${CHANGELOG}/`,
] as const;

const UTILITY_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  ["ai-info", [`${SRC}/pages/ai-info.astro`, `${SRC}/data/ai-facts.ts`]],
  [
    "security",
    [`${SRC}/pages/security.astro`, `${SRC}/data/security-controls.ts`],
  ],
  ["changelog", [`${SRC}/pages/changelog.astro`, ...CHANGELOG_SOURCES]],
  ["press", [`${SRC}/pages/press.astro`]],
  ["privacy", [`${SRC}/pages/privacy.astro`]],
  ["terms", [`${SRC}/pages/terms.astro`]],
  ["imprint", [`${SRC}/pages/imprint.astro`]],
  ["docx-editor", [`${SRC}/pages/docx-editor.astro`]],
  ["blog", [`${SRC}/pages/blog/index.astro`, `${BLOG}/`]],
]);

type SitemapSourcesOptions = {
  pathname: string;
  // URL path prefix → locale tag, default locale excluded (it sits at root).
  localeTagByPath: ReadonlyMap<string, string>;
};

// Repo-relative paths whose last change dates the page. Unknown pages panic:
// a new page type must decide what dates it, not inherit a guess.
export const sitemapSources = ({
  pathname,
  localeTagByPath,
}: SitemapSourcesOptions): readonly string[] => {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const first = segments.at(0);
  const localeTag =
    first === undefined ? undefined : localeTagByPath.get(first);
  const rest = localeTag === undefined ? segments : segments.slice(1);
  const head = rest.at(0);
  const tail = rest.slice(1);
  const messages = `${MESSAGES}/${localeTag ?? "en"}.json`;

  if (head === undefined) {
    return [
      `${SRC}/components/HomePage.astro`,
      `${SRC}/data/product-story.ts`,
      messages,
      ...CHANGELOG_SOURCES,
    ];
  }
  const slug = tail.at(0);
  if (head === "product" && slug !== undefined && tail.length === 1) {
    return [
      `${SRC}/data/products/${slug}.ts`,
      `${SRC}/components/ProductPage.astro`,
      `${SRC}/i18n/product-copy.ts`,
      messages,
    ];
  }
  if (localeTag !== undefined) {
    return panic(
      `sitemap lastmod: localized page without a source mapping: ${pathname}`,
    );
  }
  if (head === "docs") {
    const entry = tail.length === 0 ? "index" : tail.join("/");
    return [`${DOCS}/${entry}.md`, `${DOCS}/${entry}.mdx`];
  }
  if (head === "blog" && slug !== undefined && tail.length === 1) {
    return [`${BLOG}/${slug}.md`];
  }
  const utility = tail.length === 0 ? UTILITY_SOURCES.get(head) : undefined;
  if (utility !== undefined) {
    return utility;
  }
  return panic(`sitemap lastmod: no source mapping for ${pathname}`);
};

// Newest commit date across the sources, as an ISO-8601 instant. Missing
// sources are skipped (a candidate that does not exist, an .md beside an
// .mdx); no date at all means the mapping is wrong and panics.
export const lastmodFromDates = (
  sources: readonly string[],
  dateBySource: ReadonlyMap<string, string>,
): string => {
  let latest: number | undefined;
  for (const source of sources) {
    const candidates = source.endsWith("/")
      ? [...dateBySource]
          .filter(([path]) => path.startsWith(source))
          .map(([, date]) => date)
      : [dateBySource.get(source)];
    for (const candidate of candidates) {
      if (candidate === undefined) {
        continue;
      }
      const instant = Date.parse(candidate);
      if (latest === undefined || instant > latest) {
        latest = instant;
      }
    }
  }
  if (latest === undefined) {
    return panic(
      `sitemap lastmod: none of the sources exist in history: ${sources.join(", ")}`,
    );
  }
  return new Date(latest).toISOString();
};

// ASCII record separator: cannot occur in a path, so it marks the date lines.
const RECORD_SEPARATOR = "";

// One `git log` over the landing sources; the first time a path appears is
// its newest commit because the log is newest-first.
export const parseGitLog = (log: string): ReadonlyMap<string, string> => {
  const dateBySource = new Map<string, string>();
  let current: string | undefined;
  for (const line of log.split("\n")) {
    if (line.startsWith(RECORD_SEPARATOR)) {
      current = line.slice(RECORD_SEPARATOR.length);
      continue;
    }
    if (line === "" || current === undefined || dateBySource.has(line)) {
      continue;
    }
    dateBySource.set(line, current);
  }
  return dateBySource;
};

const GIT_LOG_MAX_BYTES = 64 * 1024 * 1024;

// undefined when git is not installed or the command fails (for example a
// build from a source archive with no repository).
const git = (args: readonly string[], cwd?: string): string | undefined => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: GIT_LOG_MAX_BYTES,
  });
  return result.error === undefined && result.status === 0
    ? result.stdout.trim()
    : undefined;
};

// undefined = no usable history: no git, no repository, or a shallow clone.
const readGitDates = (): ReadonlyMap<string, string> | undefined => {
  const shallow = git(["rev-parse", "--is-shallow-repository"]);
  if (shallow === undefined || shallow === "true") {
    return undefined;
  }
  const root = git(["rev-parse", "--show-toplevel"]);
  if (root === undefined) {
    return undefined;
  }
  const log = git(
    [
      "log",
      `--format=${RECORD_SEPARATOR}%cI`,
      "--name-only",
      "--",
      SRC,
      CHANGELOG,
    ],
    root,
  );
  return log === undefined ? undefined : parseGitLog(log);
};

type SitemapLastmodOptions = {
  localeTagByPath: ReadonlyMap<string, string>;
};

type SitemapLastmod = {
  // Reads history once when the build starts, so the sitemap's serialize()
  // (which runs in its own build:done hook) never touches git itself.
  integration: AstroIntegration;
  // lastmod for a sitemap URL; undefined when history is unavailable.
  lastmodFor: (url: string) => string | undefined;
};

export const sitemapLastmod = ({
  localeTagByPath,
}: SitemapLastmodOptions): SitemapLastmod => {
  let history:
    | { dateBySource: ReadonlyMap<string, string> | undefined }
    | undefined;
  return {
    integration: {
      name: "sitemap-lastmod",
      hooks: {
        "astro:build:start": ({ logger }) => {
          const dateBySource = readGitDates();
          if (dateBySource === undefined) {
            logger.warn(
              "no usable git history: the sitemap will carry no <lastmod>",
            );
          }
          history = { dateBySource };
        },
      },
    },
    lastmodFor: (url) => {
      if (history === undefined) {
        return panic(
          "sitemap lastmod: asked for a date before the build started",
        );
      }
      if (history.dateBySource === undefined) {
        return undefined;
      }
      const sources = sitemapSources({
        pathname: new URL(url).pathname,
        localeTagByPath,
      });
      return lastmodFromDates(sources, history.dateBySource);
    },
  };
};
