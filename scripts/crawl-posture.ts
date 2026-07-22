// Crawl-posture convention guard.
//
// Stella splits its web surfaces in two: public SSR pages (the landing site)
// must be fully crawlable — indexed by search engines AND readable by LLM bots
// — while the private authenticated app must be invisible to crawlers. This
// guard makes that split structural: every app under apps/ declares a
// `crawlPosture` in its package.json, and CI verifies the on-disk artifacts
// (robots.txt, per-page robots meta tags, llms.txt) actually match the declared
// posture. A posture and its artifacts can no longer silently drift apart.
//
// Postures:
//   public   — an indexable SEO/LLM surface. robots.txt must invite crawlers
//              (a Sitemap, no wildcard or bot-specific deny-all), an llms.txt
//              must exist, and no source page may carry a `noindex` robots meta.
//   private  — an authenticated app that must stay invisible to crawlers.
//              robots.txt must deny all (`User-agent: *` + `Disallow: /`) with
//              no Sitemap and no `Allow:` rule (a more specific Allow can beat
//              the deny-all for the paths it names), every served *.html must
//              carry a `noindex` robots meta, and no llms.txt may exist (it
//              would advertise the surface).
//   unserved — not an internet-facing HTML surface (API, desktop shell, CLI
//              runtime, collab server). No requirements.
//
// Modes:
//   bun scripts/crawl-posture.ts             CI gate over apps/ (same as --check)
//   bun scripts/crawl-posture.ts --check     CI gate over apps/ (explicit)
//   bun scripts/crawl-posture.ts --self-test prove each detector fires
//
// CI-only wiring lives in .github/workflows/ci.yml and scripts/verify.sh
// alongside the other convention guards.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const APPS_ROOT = path.join(REPO_ROOT, "apps");

// --- Posture domain ---------------------------------------------------------

const CRAWL_POSTURES = ["public", "private", "mixed", "unserved"] as const;
type CrawlPosture = (typeof CRAWL_POSTURES)[number];

const isCrawlPosture = (value: unknown): value is CrawlPosture =>
  typeof value === "string" &&
  (CRAWL_POSTURES as readonly string[]).includes(value);

const POSTURE_HELP =
  'add a top-level "crawlPosture" to package.json: ' +
  '"public" (indexable SEO/LLM surface), ' +
  '"private" (authenticated app, must be invisible to crawlers), ' +
  '"mixed" (an SSR app with both public and private routes, served by a ' +
  "dynamic default-deny robots route with an explicit public allowlist), or " +
  '"unserved" (not an internet-facing HTML surface).';

// Mixed apps serve crawl policy dynamically from server routes rather than from
// static files, so the guard checks the source of those routes instead. These
// paths are relative to the app directory.
const MIXED_ROBOTS_ROUTE = "src/routes/robots[.]txt.ts";
const MIXED_SITEMAP_ROUTE = "src/routes/sitemap[.]xml.ts";
const MIXED_ROBOTS_LIB = "src/lib/public-law-sitemap.ts";
const MIXED_ROUTES_DIR = "src/routes";
const MIXED_INDEX_HTML = "index.html";
const MIXED_CRAWL_PREFIX_CONST = "PUBLIC_CRAWL_PATH_PREFIXES";

// Source files scanned for a stray `noindex` robots meta on a public surface.
const PUBLIC_SRC_GLOB = "**/*.{astro,html,tsx,ts,mdx,md}";

// --- Violations -------------------------------------------------------------
// A stable `code` discriminator identifies which detector fired (drives the
// self-test); `message` and `fix` are the human-facing output.

type ViolationCode =
  | "missing-posture"
  | "invalid-posture"
  | "private-robots-missing"
  | "private-robots-not-deny-all"
  | "private-robots-has-sitemap"
  | "private-robots-has-allow"
  | "private-robots-permissive-bot-group"
  | "private-html-no-noindex"
  | "private-has-llms"
  | "public-robots-missing"
  | "public-robots-deny-all"
  | "public-robots-bot-specific-deny-all"
  | "public-robots-missing-sitemap"
  | "public-llms-missing"
  | "public-src-noindex"
  | "mixed-robots-route-missing"
  | "mixed-static-robots-present"
  | "mixed-sitemap-route-missing"
  | "mixed-index-html-robots-meta"
  | "mixed-lib-missing"
  | "mixed-lib-no-default-deny"
  | "mixed-lib-constant-unused"
  | "mixed-allow-not-in-constant"
  | "mixed-prefix-no-route";

type Violation = {
  readonly app: string;
  readonly code: ViolationCode;
  readonly message: string;
  readonly fix: string;
};

// --- robots.txt parsing -----------------------------------------------------
// A record group is one or more stacked `User-agent` lines followed by their
// rules, per the robots.txt grouping convention. `Sitemap` is a non-group
// directive, so it is detected against the raw text instead.

type RobotsRule = { readonly field: string; readonly value: string };
type RobotsGroup = { readonly agents: string[]; readonly rules: RobotsRule[] };

const parseRobotsGroups = (text: string): RobotsGroup[] => {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  // True while consecutive `User-agent` lines are still stacking onto the
  // current group; the first rule line closes the agent list, and the next
  // `User-agent` after a rule starts a fresh group.
  let stackingAgents = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    if (line === "") {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (current === null || !stackingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
      stackingAgents = true;
      continue;
    }
    if (current === null) {
      continue;
    }
    current.rules.push({ field, value });
    stackingAgents = false;
  }
  return groups;
};

const SITEMAP_LINE = /^\s*sitemap\s*:/imu;

const hasSitemapLine = (robotsText: string): boolean =>
  SITEMAP_LINE.test(robotsText);

// A deny-all for every crawler: a `User-agent: *` group carrying `Disallow: /`.
const hasDenyAll = (robotsText: string): boolean =>
  parseRobotsGroups(robotsText).some(
    (group) =>
      group.agents.includes("*") &&
      group.rules.some(
        (rule) => rule.field === "disallow" && rule.value === "/",
      ),
  );

// Any `Allow:` rule at all, in any group. Crawlers resolve Allow/Disallow by
// most-specific-path-wins, so a single `Allow: /public` rule can carve a hole
// in an otherwise deny-all robots.txt; a private app must never emit one.
const hasAnyAllowRule = (robotsText: string): boolean =>
  parseRobotsGroups(robotsText).some((group) =>
    group.rules.some((rule) => rule.field === "allow"),
  );

// A non-wildcard group (e.g. `User-agent: Googlebot`) that does not itself
// deny all. Per the robots.txt spec, a crawler follows the MOST SPECIFIC
// group that names it and ignores the wildcard fallback entirely — so a
// `User-agent: Googlebot` group with `Allow: /` (or no rules at all) lets
// that bot in even though the `User-agent: *` group denies everyone else.
// `hasDenyAll`/`hasAnyAllowRule` only inspect the wildcard group and a
// deny-all's own `Allow:` lines, so neither catches this. A group whose
// stacked agents include `*` shares the wildcard's rules and is exempt.
const hasPermissiveBotGroup = (robotsText: string): boolean =>
  parseRobotsGroups(robotsText).some(
    (group) =>
      !group.agents.includes("*") &&
      !group.rules.some(
        (rule) => rule.field === "disallow" && rule.value === "/",
      ),
  );

// A non-wildcard group (e.g. `User-agent: Googlebot`) that denies all itself.
// Per the robots.txt spec, a crawler follows the MOST SPECIFIC group that names
// it and ignores the wildcard fallback entirely — so a `User-agent: Googlebot`
// group with `Disallow: /` blocks that bot even though the wildcard
// `User-agent: *` group invites everyone else. `hasDenyAll` only inspects the
// wildcard group, so it does not catch this. A group whose stacked agents
// include `*` shares the wildcard's rules and is exempt. This mirrors
// `hasPermissiveBotGroup` on the private side: there a bot-specific group can
// carve an unwanted opening in a deny-all; here one can carve an unwanted
// closure in an invite-all.
const hasBotSpecificDenyAll = (robotsText: string): boolean =>
  parseRobotsGroups(robotsText).some(
    (group) =>
      !group.agents.includes("*") &&
      group.rules.some(
        (rule) => rule.field === "disallow" && rule.value === "/",
      ),
  );

// --- robots meta detection --------------------------------------------------
// Matches a `<meta name="robots" ...>` tag whose directives include `noindex`,
// regardless of attribute order.

const META_TAG = /<meta\b[^>]*>/giu;
const ROBOTS_NAME_ATTR = /\bname\s*=\s*["']robots["']/iu;
const CONTENT_ATTR = /\bcontent\s*=\s*["']([^"']*)["']/iu;

// `noindex` as a comma/whitespace-delimited directive token inside the robots
// meta `content` value — not a raw substring of the whole tag, which would both
// false-positive on unrelated attribute values and be order-sensitive.
const robotsContentHasNoindex = (tag: string): boolean => {
  const content = CONTENT_ATTR.exec(tag)?.[1];
  if (content === undefined) {
    return false;
  }
  return content
    .split(/[\s,]+/u)
    .some((token) => token.toLowerCase() === "noindex");
};

const hasNoindexRobotsMeta = (html: string): boolean => {
  for (const match of html.matchAll(META_TAG)) {
    const tag = match[0];
    if (ROBOTS_NAME_ATTR.test(tag) && robotsContentHasNoindex(tag)) {
      return true;
    }
  }
  return false;
};

// Any `<meta name="robots" ...>` tag at all (a mixed SSR app owns robots meta
// per-route in the router; a static one in the app-root HTML would apply to
// public and private pages alike).
const hasRobotsMetaTag = (html: string): boolean => {
  for (const match of html.matchAll(META_TAG)) {
    if (ROBOTS_NAME_ATTR.test(match[0])) {
      return true;
    }
  }
  return false;
};

// --- Mixed (dynamic SSR) robots-source helpers ------------------------------

// Strip comments before lexical checks so a commented-out `Allow:` example or a
// prose mention of the constant cannot satisfy (or trip) a detector. Removes
// `/* ... */` blocks, then drops line comments ONLY when the trimmed line
// starts with `//`. A naive `//.*$` would eat the tail of any line containing a
// URL (`https://…`) and is deliberately avoided; a trailing `// ...` comment on
// a code line is left in place (harmless for these presence/allowlist checks).
const stripSourceComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

// The indexable branch emits its default-deny as a quoted `"Disallow: /"`
// array element (distinct from the non-indexable branch's template line and
// from any backtick-quoted mention in a comment), so match the quoted literal.
const INDEXABLE_DEFAULT_DENY = /["']Disallow:\s*\/["']/u;
// An `Allow:` directive whose value is a literal path (`Allow: /law`, and with
// the boundary emission `Allow: /law/` or `Allow: /law$`); the leading `/`
// requirement skips the generated `Allow: ${prefix}...` template form.
const ALLOW_PATH_LITERAL = /Allow:\s*(\/[^\s"'`]+)/gu;
const QUOTED_STRING = /["'`]([^"'`]+)["'`]/gu;

// Normalize an emitted allow path back to its crawl-prefix by dropping a
// trailing boundary marker (`/` subtree rule or `$` exact-path anchor).
const allowPathToPrefix = (allowPath: string): string =>
  allowPath.replace(/[/$]$/u, "");

// The body of `createRobotsTxt` (from its declaration to the next top-level
// `export`, or end of file). Used to confirm the function actually consults the
// crawl-prefix constant rather than hand-building Allow lines around it.
const createRobotsTxtBody = (source: string): string | null => {
  const marker = "createRobotsTxt";
  const start = source.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const rest = source.slice(start + marker.length);
  const nextExport = rest.search(/\nexport\s/u);
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
};

// String entries of `export const <NAME> = [ ... ] as const`.
const crawlPrefixConstantEntries = (
  source: string,
  constName: string,
): string[] => {
  const declaration = new RegExp(
    `${constName}\\s*=\\s*\\[([^\\]]*)\\]`,
    "u",
  ).exec(source);
  if (declaration === null) {
    return [];
  }
  const body = declaration[1];
  if (body === undefined) {
    return [];
  }
  return [...body.matchAll(QUOTED_STRING)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
};

const isDirectory = (candidate: string): boolean =>
  existsSync(candidate) && statSync(candidate).isDirectory();

// A public crawl prefix (e.g. `/law`, `/sitemap.xml`) resolves to a real route
// under routesDir. Directory route: `<routesDir>/<rel>/`. File route: the
// TanStack filename escapes each dot as `[.]`, so `/sitemap.xml` maps to a file
// `sitemap[.]xml.<ext>`. Implemented generically, not as a per-prefix table.
const routeExistsForPrefix = (routesDir: string, prefix: string): boolean => {
  const rel = prefix.replace(/^\//u, "");
  if (rel === "") {
    return false;
  }
  if (isDirectory(path.join(routesDir, rel))) {
    return true;
  }
  const segments = rel.split("/");
  const last = segments.pop();
  if (last === undefined || last === "") {
    return false;
  }
  const parent = path.join(routesDir, ...segments);
  if (!existsSync(parent)) {
    return false;
  }
  const escaped = last.replaceAll(".", "[.]");
  return readdirSync(parent).some((entry) => entry.startsWith(`${escaped}.`));
};

// --- Filesystem helpers -----------------------------------------------------

const readTextIfExists = (file: string): string | null =>
  existsSync(file) ? readFileSync(file, "utf-8") : null;

// Served *.html files for a private app: the app root (non-recursive) plus
// everything under public/ (recursive).
const servedHtmlFiles = (appDir: string): string[] => {
  const files: string[] = [];
  for (const rel of new Bun.Glob("*.html").scanSync({ cwd: appDir })) {
    files.push(rel);
  }
  const publicDir = path.join(appDir, "public");
  if (existsSync(publicDir)) {
    for (const rel of new Bun.Glob("**/*.html").scanSync({ cwd: publicDir })) {
      files.push(path.join("public", rel));
    }
  }
  return files.sort();
};

// --- Per-posture checks -----------------------------------------------------

const checkPrivate = (appDir: string, app: string): Violation[] => {
  const violations: Violation[] = [];
  const robots = readTextIfExists(path.join(appDir, "public", "robots.txt"));

  if (robots === null) {
    violations.push({
      app,
      code: "private-robots-missing",
      message: "private app is missing public/robots.txt.",
      fix: "add public/robots.txt with a `User-agent: *` / `Disallow: /` deny-all block.",
    });
  } else {
    if (!hasDenyAll(robots)) {
      violations.push({
        app,
        code: "private-robots-not-deny-all",
        message: "private app public/robots.txt does not deny all crawlers.",
        fix: "the `User-agent: *` group must contain `Disallow: /` (deny-all).",
      });
    }
    if (hasSitemapLine(robots)) {
      violations.push({
        app,
        code: "private-robots-has-sitemap",
        message: "private app public/robots.txt advertises a Sitemap.",
        fix: "remove the `Sitemap:` line; a private surface must not point crawlers at a sitemap.",
      });
    }
    if (hasAnyAllowRule(robots)) {
      violations.push({
        app,
        code: "private-robots-has-allow",
        message:
          "private app public/robots.txt contains an `Allow:` rule alongside the deny-all.",
        fix: "remove the `Allow:` rule; a more specific Allow can override the deny-all for the paths it names.",
      });
    }
    if (hasPermissiveBotGroup(robots)) {
      violations.push({
        app,
        code: "private-robots-permissive-bot-group",
        message:
          "private app public/robots.txt contains a bot-specific `User-agent` group that does not itself deny all.",
        fix: "remove the bot-specific group, or add `Disallow: /` to it: a named bot follows only its own most-specific group and ignores the wildcard deny-all.",
      });
    }
  }

  for (const rel of servedHtmlFiles(appDir)) {
    const html = readFileSync(path.join(appDir, rel), "utf-8");
    if (!hasNoindexRobotsMeta(html)) {
      violations.push({
        app,
        code: "private-html-no-noindex",
        message: `private app served page ${rel} has no \`noindex\` robots meta.`,
        fix: `add <meta name="robots" content="noindex, nofollow" /> to the <head> of ${rel}.`,
      });
    }
  }

  if (existsSync(path.join(appDir, "public", "llms.txt"))) {
    violations.push({
      app,
      code: "private-has-llms",
      message: "private app ships a public/llms.txt.",
      fix: "remove public/llms.txt; it advertises the surface to LLM crawlers.",
    });
  }

  return violations;
};

const checkPublic = (appDir: string, app: string): Violation[] => {
  const violations: Violation[] = [];
  const robots = readTextIfExists(path.join(appDir, "public", "robots.txt"));

  if (robots === null) {
    violations.push({
      app,
      code: "public-robots-missing",
      message: "public app is missing public/robots.txt.",
      fix: "add public/robots.txt with a `Sitemap:` line and no deny-all.",
    });
  } else {
    if (hasDenyAll(robots)) {
      violations.push({
        app,
        code: "public-robots-deny-all",
        message:
          "public app public/robots.txt contains a deny-all `Disallow: /`.",
        fix: "remove the deny-all; a public surface must invite crawlers.",
      });
    }
    if (hasBotSpecificDenyAll(robots)) {
      violations.push({
        app,
        code: "public-robots-bot-specific-deny-all",
        message:
          "public app public/robots.txt contains a bot-specific `User-agent` group that denies all.",
        fix: "remove the bot-specific group, or its `Disallow: /`: a named bot follows only its own most-specific group and ignores the wildcard invite.",
      });
    }
    if (!hasSitemapLine(robots)) {
      violations.push({
        app,
        code: "public-robots-missing-sitemap",
        message: "public app public/robots.txt has no `Sitemap:` line.",
        fix: "add a `Sitemap:` line pointing at the site's sitemap.",
      });
    }
  }

  if (!existsSync(path.join(appDir, "public", "llms.txt"))) {
    violations.push({
      app,
      code: "public-llms-missing",
      message: "public app is missing public/llms.txt.",
      fix: "add public/llms.txt so LLM crawlers can read the surface.",
    });
  }

  const srcDir = path.join(appDir, "src");
  if (existsSync(srcDir)) {
    for (const rel of new Bun.Glob(PUBLIC_SRC_GLOB).scanSync({ cwd: srcDir })) {
      const text = readFileSync(path.join(srcDir, rel), "utf-8");
      if (hasNoindexRobotsMeta(text)) {
        violations.push({
          app,
          code: "public-src-noindex",
          message: `public app source ${path.join("src", rel)} sets a \`noindex\` robots meta.`,
          fix: "remove the noindex robots meta; a public surface must stay indexable.",
        });
      }
    }
  }

  return violations;
};

const checkMixed = (appDir: string, app: string): Violation[] => {
  const violations: Violation[] = [];

  // a. dynamic robots route present (it is the source of truth for policy).
  if (!existsSync(path.join(appDir, MIXED_ROBOTS_ROUTE))) {
    violations.push({
      app,
      code: "mixed-robots-route-missing",
      message: `mixed app is missing the dynamic robots route ${MIXED_ROBOTS_ROUTE}.`,
      fix: `add ${MIXED_ROBOTS_ROUTE} serving createRobotsTxt(); it is the source of truth for crawl policy.`,
    });
  }

  // b. no static robots.txt (it would shadow the dynamic route).
  if (existsSync(path.join(appDir, "public", "robots.txt"))) {
    violations.push({
      app,
      code: "mixed-static-robots-present",
      message:
        "mixed app ships a static public/robots.txt that shadows the dynamic robots route.",
      fix: "delete public/robots.txt; the dynamic server route must serve robots.txt.",
    });
  }

  // c. dynamic sitemap route present.
  if (!existsSync(path.join(appDir, MIXED_SITEMAP_ROUTE))) {
    violations.push({
      app,
      code: "mixed-sitemap-route-missing",
      message: `mixed app is missing the dynamic sitemap route ${MIXED_SITEMAP_ROUTE}.`,
      fix: `add ${MIXED_SITEMAP_ROUTE}; the sitemap is served dynamically.`,
    });
  }

  // d. the app-root HTML carries no static robots meta (router owns per-page
  //    meta; a static one would apply to public and private pages alike).
  const indexHtml = readTextIfExists(path.join(appDir, MIXED_INDEX_HTML));
  if (indexHtml !== null && hasRobotsMetaTag(indexHtml)) {
    violations.push({
      app,
      code: "mixed-index-html-robots-meta",
      message: `mixed app ${MIXED_INDEX_HTML} contains a static robots <meta> tag.`,
      fix: `remove the robots <meta> from ${MIXED_INDEX_HTML}; per-page robots meta is router-owned.`,
    });
  }

  // e. the robots lib default-denies, and its allowlist and the crawl-prefix
  //    constant stay in sync with real routes.
  const rawLibSource = readTextIfExists(path.join(appDir, MIXED_ROBOTS_LIB));
  if (rawLibSource === null) {
    violations.push({
      app,
      code: "mixed-lib-missing",
      message: `mixed app is missing the robots source ${MIXED_ROBOTS_LIB}.`,
      fix: `add ${MIXED_ROBOTS_LIB} exporting createRobotsTxt and ${MIXED_CRAWL_PREFIX_CONST}.`,
    });
    return violations;
  }

  // Strip comments before lexical checks: a commented-out `Allow:` example or a
  // prose mention of the constant must not satisfy or trip a detector.
  const libSource = stripSourceComments(rawLibSource);

  // The indexable branch must carry a default-deny after its allowlist, so any
  // route not in the allowlist stays private by default.
  if (!INDEXABLE_DEFAULT_DENY.test(libSource)) {
    violations.push({
      app,
      code: "mixed-lib-no-default-deny",
      message: `${MIXED_ROBOTS_LIB} indexable robots branch has no default-deny \`Disallow: /\` line.`,
      fix: "end the indexable robots.txt with `Disallow: /` so unlisted routes are private by default.",
    });
  }

  // createRobotsTxt must build its Allow lines from the crawl-prefix constant;
  // if its body never references the identifier, the allowlist has been
  // bypassed with hand-built rules and the whole guard is moot.
  const body = createRobotsTxtBody(libSource);
  if (body === null || !body.includes(MIXED_CRAWL_PREFIX_CONST)) {
    violations.push({
      app,
      code: "mixed-lib-constant-unused",
      message: `${MIXED_ROBOTS_LIB} createRobotsTxt does not reference ${MIXED_CRAWL_PREFIX_CONST}.`,
      fix: `build the Allow lines from ${MIXED_CRAWL_PREFIX_CONST} so the allowlist cannot be bypassed by hand-built rules.`,
    });
  }

  const prefixes = crawlPrefixConstantEntries(
    libSource,
    MIXED_CRAWL_PREFIX_CONST,
  );

  // Every literal `Allow: /path` in the source, once its boundary marker (`/`
  // or `$`) is dropped, must be an allow-listed prefix, so a hand-added allow
  // cannot bypass the single crawl-prefix allowlist.
  const constantSet = new Set(prefixes);
  for (const match of libSource.matchAll(ALLOW_PATH_LITERAL)) {
    const allowPath = match[1];
    if (allowPath === undefined) {
      continue;
    }
    const prefix = allowPathToPrefix(allowPath);
    if (!constantSet.has(prefix)) {
      violations.push({
        app,
        code: "mixed-allow-not-in-constant",
        message: `${MIXED_ROBOTS_LIB} allows \`${allowPath}\`, whose prefix \`${prefix}\` is not in ${MIXED_CRAWL_PREFIX_CONST}.`,
        fix: `add ${prefix} to ${MIXED_CRAWL_PREFIX_CONST} or remove the Allow line.`,
      });
    }
  }

  // Every allow-listed prefix must map to a real route, so the allowlist cannot
  // advertise a path the app does not serve.
  const routesDir = path.join(appDir, MIXED_ROUTES_DIR);
  for (const prefix of prefixes) {
    if (!routeExistsForPrefix(routesDir, prefix)) {
      violations.push({
        app,
        code: "mixed-prefix-no-route",
        message: `${MIXED_CRAWL_PREFIX_CONST} lists \`${prefix}\`, but no route resolves under ${MIXED_ROUTES_DIR}.`,
        fix: `add a route for ${prefix} (a ${MIXED_ROUTES_DIR}/<path>/ dir or a <path>[.]<ext> route file) or drop it from ${MIXED_CRAWL_PREFIX_CONST}.`,
      });
    }
  }

  return violations;
};

// --- App enumeration + aggregation ------------------------------------------

type AppReport = {
  readonly app: string;
  readonly posture: CrawlPosture | null;
  readonly violations: readonly Violation[];
};

const checkApp = (appsRoot: string, app: string): AppReport => {
  const appDir = path.join(appsRoot, app);
  const pkg: unknown = JSON.parse(
    readFileSync(path.join(appDir, "package.json"), "utf-8"),
  );
  const posture =
    typeof pkg === "object" && pkg !== null && "crawlPosture" in pkg
      ? pkg.crawlPosture
      : undefined;

  if (posture === undefined) {
    return {
      app,
      posture: null,
      violations: [
        {
          app,
          code: "missing-posture",
          message: 'package.json has no top-level "crawlPosture".',
          fix: POSTURE_HELP,
        },
      ],
    };
  }
  if (!isCrawlPosture(posture)) {
    return {
      app,
      posture: null,
      violations: [
        {
          app,
          code: "invalid-posture",
          message: `package.json "crawlPosture" is ${JSON.stringify(posture)}, not one of ${CRAWL_POSTURES.join(", ")}.`,
          fix: POSTURE_HELP,
        },
      ],
    };
  }

  if (posture === "private") {
    return { app, posture, violations: checkPrivate(appDir, app) };
  }
  if (posture === "public") {
    return { app, posture, violations: checkPublic(appDir, app) };
  }
  if (posture === "mixed") {
    return { app, posture, violations: checkMixed(appDir, app) };
  }
  return { app, posture, violations: [] };
};

// Direct children of apps/ that contain a package.json.
const listApps = (appsRoot: string): string[] =>
  readdirSync(appsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(appsRoot, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort();

type CheckResult = {
  readonly reports: readonly AppReport[];
  readonly violations: readonly Violation[];
};

const checkAll = (appsRoot: string): CheckResult => {
  const reports = listApps(appsRoot).map((app) => checkApp(appsRoot, app));
  const violations = reports.flatMap((report) => report.violations);
  return { reports, violations };
};

// --- Modes ------------------------------------------------------------------

const summarize = (reports: readonly AppReport[]): string => {
  const counts: Record<CrawlPosture | "invalid", number> = {
    public: 0,
    private: 0,
    mixed: 0,
    unserved: 0,
    invalid: 0,
  };
  for (const report of reports) {
    counts[report.posture ?? "invalid"] += 1;
  }
  return `${reports.length} app(s): ${counts.public} public, ${counts.private} private, ${counts.mixed} mixed, ${counts.unserved} unserved`;
};

const runCheck = (appsRoot: string): number => {
  const { reports, violations } = checkAll(appsRoot);

  if (violations.length === 0) {
    console.log(`crawl-posture --check: OK. ${summarize(reports)}.`);
    return 0;
  }

  console.error("\ncrawl-posture --check: posture violation(s):\n");
  for (const report of reports) {
    if (report.violations.length === 0) {
      continue;
    }
    const postureLabel = report.posture ?? "unknown posture";
    console.error(`  ${report.app} (${postureLabel}):`);
    for (const violation of report.violations) {
      console.error(`      - ${violation.message}`);
      console.error(`        fix: ${violation.fix}`);
    }
  }
  console.error(
    "\nEach app's on-disk crawl artifacts must match its declared crawlPosture.\n" +
      "Fix the artifact(s) above, or correct the posture in the app's package.json.",
  );
  return 1;
};

// --- Self-test --------------------------------------------------------------
// Materialize synthetic app fixtures under temp apps-roots and assert each
// detector fires (and that a fully valid set passes). Exercises the same
// checkApp/checkAll used by --check, only with the apps-root parameterized.

const writeFixtureFile = (root: string, rel: string, content: string): void => {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

const NOINDEX_HTML =
  '<!doctype html><html><head><meta name="robots" content="noindex, nofollow" /></head><body></body></html>\n';
const PLAIN_HTML = "<!doctype html><html><head></head><body></body></html>\n";
const DENY_ALL_ROBOTS = "User-agent: *\nDisallow: /\n";
const DENY_ALL_ROBOTS_WITH_SITEMAP =
  "User-agent: *\nDisallow: /\n\nSitemap: https://example.com/sitemap.xml\n";
const NOT_DENY_ALL_ROBOTS = "User-agent: *\nDisallow: /admin\n";
const DENY_ALL_ROBOTS_WITH_ALLOW =
  "User-agent: *\nDisallow: /\nAllow: /public\n";
const DENY_ALL_ROBOTS_WITH_BOT_CARVEOUT =
  "User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n";
const PUBLIC_ROBOTS =
  "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n";
const PUBLIC_ROBOTS_NO_SITEMAP = "User-agent: *\nAllow: /\n";
const PUBLIC_ROBOTS_WITH_BOT_DENY_ALL =
  "User-agent: *\nAllow: /\n\nUser-agent: Googlebot\nDisallow: /\n\nSitemap: https://example.com/sitemap.xml\n";
const LLMS_TXT = "# Example\nA public surface for LLM readers.\n";

const pkg = (posture: string): string =>
  `${JSON.stringify({ name: `@stll/${posture}`, crawlPosture: posture }, null, 2)}\n`;

// --- Mixed fixtures ---------------------------------------------------------
// The guard only reads these lexically, so the fixtures are minimal stand-ins,
// not runnable modules. Allow lines use the boundary-anchored emission
// (`<prefix>/` and `<prefix>$` for dirs, `<prefix>$` for files).
const ROUTE_STUB = "export const Route = {};\n";
const libFixture = (lines: readonly string[]): string =>
  `${lines.join("\n")}\n`;

// A valid robots lib: the crawl-prefix constant, a createRobotsTxt whose body
// references it, boundary-anchored `Allow:` literals all drawn from it, and a
// quoted `"Disallow: /"` default-deny. It also proves comment-stripping: the
// block-comment `Allow: /secret$`, the `//`-line `Allow: /admin$`, and the
// `https://` URL sitting before the real `"Disallow: /"` would each break a
// detector if stripping were naive, so this fixture passing exercises all three.
const MIXED_LIB_VALID = libFixture([
  "/* ignored example: Allow: /secret$ (block comment) */",
  'export const PUBLIC_CRAWL_PATH_PREFIXES = ["/law", "/sitemap.xml"] as const;',
  "export const createRobotsTxt = () => {",
  "  // commented-out example: Allow: /admin$",
  "  const allowed = PUBLIC_CRAWL_PATH_PREFIXES;",
  '  const url = "https://example.com/sitemap.xml"; const deny = "Disallow: /";',
  '  const lines = ["User-agent: *", "Allow: /law/", "Allow: /law$", "Allow: /sitemap.xml$", deny, ...allowed];',
  "  return { lines, url };",
  "};",
]);
// No quoted "Disallow: /" anywhere.
const MIXED_LIB_NO_DENY = libFixture([
  'export const PUBLIC_CRAWL_PATH_PREFIXES = ["/law", "/sitemap.xml"] as const;',
  "export const createRobotsTxt = () => {",
  "  const allowed = PUBLIC_CRAWL_PATH_PREFIXES;",
  '  const lines = ["User-agent: *", "Allow: /law/", "Allow: /sitemap.xml$", ...allowed];',
  "  return lines;",
  "};",
]);
// A boundary-anchored `Allow: /secret$` literal whose prefix is not in the
// constant.
const MIXED_LIB_BAD_ALLOW = libFixture([
  'export const PUBLIC_CRAWL_PATH_PREFIXES = ["/law"] as const;',
  "export const createRobotsTxt = () => {",
  "  const allowed = PUBLIC_CRAWL_PATH_PREFIXES;",
  '  const lines = ["User-agent: *", "Allow: /law/", "Allow: /secret$", "Disallow: /", ...allowed];',
  "  return lines;",
  "};",
]);
// A constant prefix (`/ghost`) that maps to no route.
const MIXED_LIB_GHOST_PREFIX = libFixture([
  'export const PUBLIC_CRAWL_PATH_PREFIXES = ["/law", "/ghost"] as const;',
  "export const createRobotsTxt = () => {",
  "  const allowed = PUBLIC_CRAWL_PATH_PREFIXES;",
  '  const lines = ["User-agent: *", "Allow: /law/", "Disallow: /", ...allowed];',
  "  return lines;",
  "};",
]);
// A law-only constant, used where /sitemap.xml must not be required as a route.
const MIXED_LIB_LAW_ONLY = libFixture([
  'export const PUBLIC_CRAWL_PATH_PREFIXES = ["/law"] as const;',
  "export const createRobotsTxt = () => {",
  "  const allowed = PUBLIC_CRAWL_PATH_PREFIXES;",
  '  const lines = ["User-agent: *", "Allow: /law/", "Disallow: /", ...allowed];',
  "  return lines;",
  "};",
]);
// createRobotsTxt hand-builds its Allow lines and never consults the constant.
const MIXED_LIB_CONSTANT_UNUSED = libFixture([
  'export const PUBLIC_CRAWL_PATH_PREFIXES = ["/law"] as const;',
  "export const createRobotsTxt = () => {",
  '  const lines = ["User-agent: *", "Allow: /law/", "Allow: /law$", "Disallow: /"];',
  "  return lines;",
  "};",
]);

// Lay out a fully valid mixed app; broken fixtures start here and mutate one
// thing. `/law` resolves to a directory route, `/sitemap.xml` to the escaped
// sitemap route file.
const layoutValidMixed = (root: string, app: string): void => {
  writeFixtureFile(root, path.join(app, "package.json"), pkg("mixed"));
  writeFixtureFile(root, path.join(app, MIXED_ROBOTS_ROUTE), ROUTE_STUB);
  writeFixtureFile(root, path.join(app, MIXED_SITEMAP_ROUTE), ROUTE_STUB);
  writeFixtureFile(
    root,
    path.join(app, MIXED_ROUTES_DIR, "law", "route.tsx"),
    ROUTE_STUB,
  );
  writeFixtureFile(root, path.join(app, MIXED_ROBOTS_LIB), MIXED_LIB_VALID);
  writeFixtureFile(root, path.join(app, MIXED_INDEX_HTML), PLAIN_HTML);
};

// One temp apps-root holding a single app fixture, run through checkApp.
const reportForSingleApp = (
  layout: (root: string, app: string) => void,
): AppReport => {
  const root = mkdtempSync(path.join(tmpdir(), "crawl-posture-selftest-"));
  const app = "fixture";
  try {
    layout(root, app);
    return checkApp(root, app);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const codes = (report: AppReport): ViolationCode[] =>
  report.violations.map((violation) => violation.code);

const runSelfTest = (): number => {
  const failures: string[] = [];

  const expectCode = (
    label: string,
    report: AppReport,
    code: ViolationCode,
  ) => {
    if (!codes(report).includes(code)) {
      failures.push(
        `${label}: expected detector "${code}" to fire, got [${codes(report).join(", ")}]`,
      );
    }
  };

  // 1. missing crawlPosture
  expectCode(
    "missing crawlPosture",
    reportForSingleApp((root, app) => {
      writeFixtureFile(
        root,
        path.join(app, "package.json"),
        `${JSON.stringify({ name: "@stll/x" }, null, 2)}\n`,
      );
    }),
    "missing-posture",
  );

  // 2. invalid value
  expectCode(
    "invalid crawlPosture",
    reportForSingleApp((root, app) => {
      writeFixtureFile(
        root,
        path.join(app, "package.json"),
        `${JSON.stringify({ name: "@stll/x", crawlPosture: "sometimes" }, null, 2)}\n`,
      );
    }),
    "invalid-posture",
  );

  // 3. private without robots.txt
  expectCode(
    "private without robots.txt",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("private"));
      writeFixtureFile(root, path.join(app, "index.html"), NOINDEX_HTML);
    }),
    "private-robots-missing",
  );

  // 4. private robots.txt without deny-all
  expectCode(
    "private robots.txt without deny-all",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("private"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        NOT_DENY_ALL_ROBOTS,
      );
      writeFixtureFile(root, path.join(app, "index.html"), NOINDEX_HTML);
    }),
    "private-robots-not-deny-all",
  );

  // 5. private robots.txt with a Sitemap line
  expectCode(
    "private robots.txt with Sitemap",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("private"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        DENY_ALL_ROBOTS_WITH_SITEMAP,
      );
      writeFixtureFile(root, path.join(app, "index.html"), NOINDEX_HTML);
    }),
    "private-robots-has-sitemap",
  );

  // 5b. private robots.txt with a deny-all plus an Allow rule
  expectCode(
    "private robots.txt with Allow rule",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("private"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        DENY_ALL_ROBOTS_WITH_ALLOW,
      );
      writeFixtureFile(root, path.join(app, "index.html"), NOINDEX_HTML);
    }),
    "private-robots-has-allow",
  );

  // 5c. private robots.txt with a wildcard deny-all plus a bot-specific group
  //     that carves its own access back out (e.g. `User-agent: Googlebot` +
  //     `Allow: /`), which that bot follows instead of the wildcard.
  expectCode(
    "private robots.txt with bot-specific carve-out",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("private"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        DENY_ALL_ROBOTS_WITH_BOT_CARVEOUT,
      );
      writeFixtureFile(root, path.join(app, "index.html"), NOINDEX_HTML);
    }),
    "private-robots-permissive-bot-group",
  );

  // 6. private index.html without noindex meta
  expectCode(
    "private index.html without noindex",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("private"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        DENY_ALL_ROBOTS,
      );
      writeFixtureFile(root, path.join(app, "index.html"), PLAIN_HTML);
    }),
    "private-html-no-noindex",
  );

  // 7. private with llms.txt
  expectCode(
    "private with llms.txt",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("private"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        DENY_ALL_ROBOTS,
      );
      writeFixtureFile(root, path.join(app, "index.html"), NOINDEX_HTML);
      writeFixtureFile(root, path.join(app, "public", "llms.txt"), LLMS_TXT);
    }),
    "private-has-llms",
  );

  // 8. public with deny-all robots.txt
  expectCode(
    "public with deny-all robots.txt",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("public"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        DENY_ALL_ROBOTS_WITH_SITEMAP,
      );
      writeFixtureFile(root, path.join(app, "public", "llms.txt"), LLMS_TXT);
    }),
    "public-robots-deny-all",
  );

  // 8a. public with a bot-specific group that denies all, even though the
  //     wildcard group invites everyone. That bot follows only its own
  //     most-specific group and ignores the wildcard invite, so it is silently
  //     blocked from a supposedly public surface.
  expectCode(
    "public with bot-specific deny-all",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("public"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        PUBLIC_ROBOTS_WITH_BOT_DENY_ALL,
      );
      writeFixtureFile(root, path.join(app, "public", "llms.txt"), LLMS_TXT);
    }),
    "public-robots-bot-specific-deny-all",
  );

  // 8b. public with no robots.txt at all.
  expectCode(
    "public missing robots.txt",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("public"));
      writeFixtureFile(root, path.join(app, "public", "llms.txt"), LLMS_TXT);
    }),
    "public-robots-missing",
  );

  // 9. public missing Sitemap line
  expectCode(
    "public missing Sitemap",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("public"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        PUBLIC_ROBOTS_NO_SITEMAP,
      );
      writeFixtureFile(root, path.join(app, "public", "llms.txt"), LLMS_TXT);
    }),
    "public-robots-missing-sitemap",
  );

  // 10. public missing llms.txt
  expectCode(
    "public missing llms.txt",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("public"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        PUBLIC_ROBOTS,
      );
    }),
    "public-llms-missing",
  );

  // 11. public src page containing a noindex robots meta
  expectCode(
    "public src with noindex",
    reportForSingleApp((root, app) => {
      writeFixtureFile(root, path.join(app, "package.json"), pkg("public"));
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        PUBLIC_ROBOTS,
      );
      writeFixtureFile(root, path.join(app, "public", "llms.txt"), LLMS_TXT);
      writeFixtureFile(
        root,
        path.join(app, "src", "pages", "index.astro"),
        '---\n---\n<meta name="robots" content="noindex" />\n',
      );
    }),
    "public-src-noindex",
  );

  // 12. mixed missing the dynamic robots route.
  expectCode(
    "mixed missing robots route",
    reportForSingleApp((root, app) => {
      layoutValidMixed(root, app);
      rmSync(path.join(root, app, MIXED_ROBOTS_ROUTE));
    }),
    "mixed-robots-route-missing",
  );

  // 13. mixed with a static robots.txt shadowing the dynamic route.
  expectCode(
    "mixed with static robots.txt",
    reportForSingleApp((root, app) => {
      layoutValidMixed(root, app);
      writeFixtureFile(
        root,
        path.join(app, "public", "robots.txt"),
        DENY_ALL_ROBOTS,
      );
    }),
    "mixed-static-robots-present",
  );

  // 14. mixed missing the dynamic sitemap route. Drop /sitemap.xml from the
  //     constant too so only the route-missing detector fires.
  expectCode(
    "mixed missing sitemap route",
    reportForSingleApp((root, app) => {
      layoutValidMixed(root, app);
      rmSync(path.join(root, app, MIXED_SITEMAP_ROUTE));
      writeFixtureFile(
        root,
        path.join(app, MIXED_ROBOTS_LIB),
        MIXED_LIB_LAW_ONLY,
      );
    }),
    "mixed-sitemap-route-missing",
  );

  // 15. mixed with a robots <meta> tag in the app-root HTML.
  expectCode(
    "mixed index.html robots meta",
    reportForSingleApp((root, app) => {
      layoutValidMixed(root, app);
      writeFixtureFile(root, path.join(app, MIXED_INDEX_HTML), NOINDEX_HTML);
    }),
    "mixed-index-html-robots-meta",
  );

  // 16. mixed robots lib missing its default-deny.
  expectCode(
    "mixed lib without default-deny",
    reportForSingleApp((root, app) => {
      layoutValidMixed(root, app);
      writeFixtureFile(
        root,
        path.join(app, MIXED_ROBOTS_LIB),
        MIXED_LIB_NO_DENY,
      );
    }),
    "mixed-lib-no-default-deny",
  );

  // 17. mixed robots lib with an Allow line not in the crawl-prefix constant.
  expectCode(
    "mixed allow not in constant",
    reportForSingleApp((root, app) => {
      layoutValidMixed(root, app);
      writeFixtureFile(
        root,
        path.join(app, MIXED_ROBOTS_LIB),
        MIXED_LIB_BAD_ALLOW,
      );
    }),
    "mixed-allow-not-in-constant",
  );

  // 18. mixed crawl-prefix constant with a prefix that maps to no route.
  expectCode(
    "mixed prefix without a route",
    reportForSingleApp((root, app) => {
      layoutValidMixed(root, app);
      writeFixtureFile(
        root,
        path.join(app, MIXED_ROBOTS_LIB),
        MIXED_LIB_GHOST_PREFIX,
      );
    }),
    "mixed-prefix-no-route",
  );

  // 19. mixed robots lib missing entirely.
  expectCode(
    "mixed missing robots lib",
    reportForSingleApp((root, app) => {
      layoutValidMixed(root, app);
      rmSync(path.join(root, app, MIXED_ROBOTS_LIB));
    }),
    "mixed-lib-missing",
  );

  // 20. mixed robots lib whose createRobotsTxt never consults the constant.
  expectCode(
    "mixed lib bypasses the crawl-prefix constant",
    reportForSingleApp((root, app) => {
      layoutValidMixed(root, app);
      writeFixtureFile(
        root,
        path.join(app, MIXED_ROBOTS_LIB),
        MIXED_LIB_CONSTANT_UNUSED,
      );
    }),
    "mixed-lib-constant-unused",
  );

  // A valid mixed app must pass clean.
  const validMixed = reportForSingleApp(layoutValidMixed);
  if (validMixed.violations.length !== 0) {
    failures.push(
      `valid mixed fixture produced violations: [${codes(validMixed).join(", ")}]`,
    );
  }

  // A fully valid set (one public, one private, one unserved) must pass clean.
  const validRoot = mkdtempSync(
    path.join(tmpdir(), "crawl-posture-selftest-valid-"),
  );
  try {
    writeFixtureFile(validRoot, "site/package.json", pkg("public"));
    writeFixtureFile(validRoot, "site/public/robots.txt", PUBLIC_ROBOTS);
    writeFixtureFile(validRoot, "site/public/llms.txt", LLMS_TXT);
    writeFixtureFile(
      validRoot,
      "site/src/pages/index.astro",
      "---\n---\n<h1>Hello</h1>\n",
    );
    writeFixtureFile(validRoot, "app/package.json", pkg("private"));
    writeFixtureFile(validRoot, "app/public/robots.txt", DENY_ALL_ROBOTS);
    writeFixtureFile(validRoot, "app/index.html", NOINDEX_HTML);
    writeFixtureFile(validRoot, "runtime/package.json", pkg("unserved"));

    const { violations } = checkAll(validRoot);
    if (violations.length !== 0) {
      failures.push(
        `valid fixture set produced violations: [${violations.map((v) => `${v.app}:${v.code}`).join(", ")}]`,
      );
    }
  } finally {
    rmSync(validRoot, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error("crawl-posture --self-test: FAIL");
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    return 1;
  }
  console.log("crawl-posture --self-test: PASS");
  return 0;
};

// --- Entry ------------------------------------------------------------------

const main = (): number => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  return runCheck(APPS_ROOT);
};

if (import.meta.main) {
  // Set exitCode rather than process.exit() so stdout/stderr flush before exit.
  process.exitCode = main();
}
