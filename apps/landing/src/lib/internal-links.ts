// Resolves the links a built page emits against the files the build wrote.
//
// A page is served from `<path>/index.html`, so its URL is `<path>/`; the
// slashless form only reaches it through a redirect, and crawlers that saw it
// before the redirect existed keep their old verdict for months. The sitemap
// is generated from the same routes, so a link that resolves to a built file
// is also a link to a URL the sitemap declares.

export type LinkIssue =
  | { type: "missing-trailing-slash"; page: string; href: string }
  | { type: "not-built"; page: string; href: string };

const TAG = /<(a|link)\s[^>]*>/gu;
const HREF = /\shref="([^"]*)"/u;
const REL = /\srel="([^"]*)"/u;

/** `<link>` relations that name a page URL rather than a resource to load. */
const PAGE_RELATIONS = new Set(["alternate", "canonical"]);

/** Every page-addressing href in a built HTML document, entity-decoded. */
export const extractPageHrefs = (html: string): string[] => {
  const hrefs: string[] = [];
  for (const [tag, name] of html.matchAll(TAG)) {
    const href = HREF.exec(tag)?.[1];
    if (href === undefined) {
      continue;
    }
    if (name === "link" && !PAGE_RELATIONS.has(REL.exec(tag)?.[1] ?? "")) {
      continue;
    }
    hrefs.push(href.replaceAll("&amp;", "&"));
  }
  return hrefs;
};

/** The URL a built file answers at: `a/index.html` is `/a/`. */
export const pageUrlPath = (file: string): string =>
  `/${file}`.replace(/(^|\/)index\.html$/u, "$1");

type FindLinkIssuesOptions = {
  site: URL;
  /** Every file in the build output, relative to its root, `/`-separated. */
  files: ReadonlySet<string>;
  /** Built HTML file path mapped to its markup. */
  pages: ReadonlyMap<string, string>;
};

export const findLinkIssues = ({
  site,
  files,
  pages,
}: FindLinkIssuesOptions): LinkIssue[] => {
  const issues: LinkIssue[] = [];
  for (const [file, html] of pages) {
    const page = pageUrlPath(file);
    const base = new URL(page, site);
    for (const href of extractPageHrefs(html)) {
      const target = new URL(href, base);
      if (target.origin !== site.origin) {
        continue;
      }
      const path = decodeURIComponent(target.pathname).slice(1);
      if (path.endsWith("/") || path === "") {
        if (!files.has(`${path}index.html`)) {
          issues.push({ type: "not-built", page, href });
        }
        continue;
      }
      if (files.has(`${path}/index.html`)) {
        issues.push({ type: "missing-trailing-slash", page, href });
        continue;
      }
      if (!files.has(path)) {
        issues.push({ type: "not-built", page, href });
      }
    }
  }
  return issues;
};
