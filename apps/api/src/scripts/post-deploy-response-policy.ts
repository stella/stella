/**
 * Post-deploy response policy checks against a deployed web origin.
 *
 * Reads Knowledge pages and JSON without a session and checks each response
 * against the headers the app declares for its route class:
 *
 * - Knowledge HTML carries `Cache-Control: private, no-store`
 *   (apps/web/src/server.ts); the CDN reports no cache hit and `Age` is absent
 *   or zero, also on an immediate repeat.
 * - Public Knowledge JSON carries `public, max-age=300` on success and
 *   `private, no-store` otherwise, and sets no cookie
 *   (apps/api/src/handlers/public-knowledge/routes.ts).
 * - Member Knowledge JSON answers a JSON 401 without a session and carries
 *   the global `private, no-store` policy.
 * - Public Knowledge pages built with the shared public head carry a robots
 *   meta tag with one of its declared values (apps/web/src/lib/public-seo.ts).
 *
 * Whether public Knowledge is enabled is detected from the API and the web
 * root head, the way the staging browser smoke does; the checks run either
 * way. Pack, template and starter ids come from the public Knowledge JSON.
 * When the API and the web origin both report a build commit and the two
 * differ, the run stops before any check. Like post-deploy-smoke.ts it
 * imports only environment-free policy helpers and runs as a plain `bun` invocation.
 *
 * Prints a JSON report (statuses and headers; never bodies or secrets) and
 * exits non-zero on any failed check.
 *
 * Env: E2E_WEB_URL (checked origin), E2E_API_URL (public Knowledge state and
 * ids), optional E2E_EDGE_HEADER_NAME / E2E_EDGE_HEADER_VALUE.
 */
import { panic, TaggedError } from "better-result";
import * as cheerio from "cheerio";
import * as v from "valibot";

import { loadCatalogue } from "@stll/catalogue";
import { printError, sanitizeErrorForOutput } from "@stll/errors";
import { fetchWithTimeout } from "@stll/fetch";

import {
  CACHE_CONTROL_HEADER,
  NO_STORE_DIRECTIVE,
  PRIVATE_CACHE_CONTROL,
  publicCacheControl,
} from "../lib/security-headers";

const REQUEST_TIMEOUT_MS = 20_000;

/** Public Knowledge JSON as the web origin serves it. */
const PUBLIC_KNOWLEDGE_WEB = "/api/v1/public/knowledge";
/** Public Knowledge JSON on the API's own origin. */
const PUBLIC_KNOWLEDGE_API = "/v1/public/knowledge";
const TEMPLATE_PACKS = "/template-packs";
const PLAYBOOK_STARTERS = "/playbook-starters";

/** Knowledge pages a visitor may open when public Knowledge is enabled. */
const KNOWLEDGE_PAGE_PATHS = [
  "/knowledge",
  "/knowledge/templates",
  "/knowledge/templates/catalogue",
  "/knowledge/playbooks",
  "/knowledge/tools",
  "/knowledge/tools/contribute",
] as const;

/** Knowledge pages that need an account. */
const SIGNED_IN_PAGE_PATHS = [
  "/knowledge/clauses",
  "/knowledge/styles",
] as const;

/** apps/web/src/server.ts: every Knowledge HTML response. */
const KNOWLEDGE_HTML_CACHE_CONTROL = PRIVATE_CACHE_CONTROL;
/** apps/api/src/handlers/public-knowledge/routes.ts: success, then the rest. */
const PUBLIC_JSON_CACHE_CONTROL = publicCacheControl({
  kind: "public",
  maxAge: 300,
});
const PUBLIC_JSON_OTHER_CACHE_CONTROL = PRIVATE_CACHE_CONTROL;
/** The global API response policy. */
export const MEMBER_JSON_CACHE_CONTROL = PRIVATE_CACHE_CONTROL;

/** Where the web origin serves the API's versioned routes. */
export const MEMBER_JSON_BASE = "/api/v1";

/** Representative member Knowledge routes checked against the global policy. */
export const MEMBER_JSON_POLICY_PATHS = [
  `${MEMBER_JSON_BASE}/playbooks/`,
  `${MEMBER_JSON_BASE}/templates/`,
  `${MEMBER_JSON_BASE}/clauses/`,
  `${MEMBER_JSON_BASE}/catalogue/`,
  `${MEMBER_JSON_BASE}/skills/`,
] as const;

/** Build commit markers the staging browser smoke reads. */
const API_BUILD_PATH = "/ready";
const WEB_BUILD_PATH = "/version.json";

/** apps/web/src/lib/public-seo.ts: crawlable and not crawlable. */
export const DECLARED_ROBOTS: ReadonlySet<string> = new Set([
  "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1",
  "noindex,nofollow",
]);

const PUBLIC_KNOWLEDGE_META = {
  name: "public-knowledge",
  content: "enabled",
} as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class ResponsePolicyError extends TaggedError("ResponsePolicyError")<{
  message: string;
  cause?: unknown;
}> {}

export const RESPONSE_CLASS = {
  /** A Knowledge page open to visitors when public Knowledge is enabled. */
  page: "page",
  /** A Knowledge page that needs an account. */
  accountPage: "account-page",
  /** Public Knowledge JSON. */
  publicJson: "public-json",
  /** Member Knowledge JSON. */
  memberJson: "member-json",
} as const;

type ResponseClass = (typeof RESPONSE_CLASS)[keyof typeof RESPONSE_CLASS];

type PublicKnowledgeState = "enabled" | "disabled";

export type Target = {
  path: string;
  responseClass: ResponseClass;
  /** Member JSON only: the Cache-Control its route declares. */
  cacheControl?: string | null;
  /** The page's head is built with the shared public head. */
  robots?: boolean;
};

/** The response fields the checks read; the body stays out of the report. */
type ResponseSnapshot = {
  /** 0 when the request did not complete. */
  status: number;
  headers: Headers;
  body: string;
};

// ---------------------------------------------------------------------------
// Header and status rules
// ---------------------------------------------------------------------------

/** Directive name (lowercase) to its value, or null for a bare directive. */
export const parseCacheControl = (
  value: string | null,
): Map<string, string | null> => {
  const directives = new Map<string, string | null>();
  for (const part of (value ?? "").split(",")) {
    const [rawName, ...rawValue] = part.split("=");
    const name = rawName?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const joined = rawValue.join("=").trim().replace(/^"|"$/gu, "");
    directives.set(name, rawValue.length > 0 ? joined : null);
  }
  return directives;
};

/** Same directives and values, in any order and spacing. */
export const matchesCacheControl = (
  actual: string | null,
  declared: string,
): boolean => {
  const actualDirectives = parseCacheControl(actual);
  const declaredDirectives = parseCacheControl(declared);
  return (
    actualDirectives.size === declaredDirectives.size &&
    [...declaredDirectives].every(
      ([name, value]) =>
        actualDirectives.has(name) && actualDirectives.get(name) === value,
    )
  );
};

/** `Hit from cloudfront` and `RefreshHit from cloudfront` are cache hits. */
export const isCdnCacheHit = (xCache: string | null): boolean =>
  /^\s*(?:refresh)?hit\b/iu.test(xCache ?? "");

export const hasZeroAge = (age: string | null): boolean =>
  age === null || age.trim() === "0";

const mediaType = (headers: Headers): string =>
  headers.get("content-type")?.split(";").at(0)?.trim().toLowerCase() ?? "";

const isPageClass = (responseClass: ResponseClass): boolean =>
  responseClass === RESPONSE_CLASS.page ||
  responseClass === RESPONSE_CLASS.accountPage;

/** The Cache-Control the app declares for this response, or null. */
export const declaredCacheControl = (
  target: Pick<Target, "responseClass" | "cacheControl">,
  { status, headers }: Pick<ResponseSnapshot, "status" | "headers">,
): string | null => {
  const { responseClass } = target;
  switch (responseClass) {
    case RESPONSE_CLASS.page:
    case RESPONSE_CLASS.accountPage: {
      return mediaType(headers) === "text/html"
        ? KNOWLEDGE_HTML_CACHE_CONTROL
        : null;
    }
    case RESPONSE_CLASS.publicJson: {
      return status >= 200 && status < 300
        ? PUBLIC_JSON_CACHE_CONTROL
        : PUBLIC_JSON_OTHER_CACHE_CONTROL;
    }
    case RESPONSE_CLASS.memberJson: {
      return target.cacheControl ?? null;
    }
    default: {
      responseClass satisfies never;
      return panic(`Unhandled response class: ${String(responseClass)}`);
    }
  }
};

/** Cache rules for one response, against what its route class declares. */
export const evaluateCachePolicy = (
  target: Pick<Target, "responseClass" | "cacheControl">,
  snapshot: Pick<ResponseSnapshot, "status" | "headers">,
): string[] => {
  const { status, headers } = snapshot;
  if (status === 0) {
    return [];
  }
  const failures: string[] = [];
  if (!headers.has("x-amz-cf-id")) {
    failures.push("no CDN response marker");
  }
  if (
    target.responseClass === RESPONSE_CLASS.publicJson &&
    status >= 200 &&
    status < 300 &&
    headers.has("set-cookie")
  ) {
    failures.push("public response sets a cookie");
  }

  const declared = declaredCacheControl(target, snapshot);
  if (declared === null) {
    return failures;
  }
  const actual = headers.get(CACHE_CONTROL_HEADER);
  if (!matchesCacheControl(actual, declared)) {
    failures.push(
      `Cache-Control "${actual ?? "absent"}", declared "${declared}"`,
    );
  }
  if (parseCacheControl(declared).has(NO_STORE_DIRECTIVE)) {
    if (isCdnCacheHit(headers.get("x-cache"))) {
      failures.push(`CDN cache hit (${headers.get("x-cache") ?? ""})`);
    }
    if (!hasZeroAge(headers.get("age"))) {
      failures.push(`Age ${headers.get("age") ?? ""}`);
    }
  }
  return failures;
};

/** Status and media type rules for one anonymous response. */
export const evaluateStatus = (
  {
    responseClass,
    publicKnowledge,
  }: { responseClass: ResponseClass; publicKnowledge: PublicKnowledgeState },
  { status, headers }: Pick<ResponseSnapshot, "status" | "headers">,
): string[] => {
  if (status === 0) {
    return ["request did not complete"];
  }
  const failures: string[] = [];
  const expectJson = (expected: number) => {
    if (status !== expected) {
      failures.push(`status ${String(status)}, expected ${String(expected)}`);
    } else if (mediaType(headers) !== "application/json") {
      failures.push(`content type ${mediaType(headers) || "absent"}`);
    }
  };
  const expectHtml = (allowRedirects: boolean) => {
    if (status === 200) {
      if (mediaType(headers) !== "text/html") {
        failures.push(`content type ${mediaType(headers) || "absent"}`);
      }
      return;
    }
    if (!(allowRedirects && REDIRECT_STATUSES.has(status))) {
      failures.push(`status ${String(status)}`);
    }
  };

  switch (responseClass) {
    case RESPONSE_CLASS.page: {
      if (publicKnowledge === "enabled") {
        expectHtml(false);
      } else if (status !== 404) {
        expectHtml(true);
      }
      break;
    }
    case RESPONSE_CLASS.accountPage: {
      expectHtml(true);
      break;
    }
    case RESPONSE_CLASS.publicJson: {
      if (publicKnowledge === "enabled") {
        expectJson(200);
      } else if (status !== 404) {
        failures.push(`status ${String(status)}, expected 404`);
      }
      break;
    }
    case RESPONSE_CLASS.memberJson: {
      expectJson(401);
      break;
    }
  }
  return failures;
};

// ---------------------------------------------------------------------------
// Head meta tags
// ---------------------------------------------------------------------------

/**
 * `content` of every `head > meta` element with this name, read from the
 * parsed document the way the staging browser smoke reads it
 * (apps/web/e2e/helpers/public-knowledge-smoke.logic.ts), so text inside
 * scripts, styles, templates and comments never counts.
 */
export const headMetaContents = (html: string, name: string): string[] => {
  const $ = cheerio.load(html);
  return $("head > meta")
    .toArray()
    .filter((meta) => $(meta).attr("name")?.toLowerCase() === name)
    .map((meta) => $(meta).attr("content") ?? "");
};

/** The page's robots meta tags carry one of the declared values. */
export const evaluateRobots = (html: string): string[] => {
  const contents = headMetaContents(html, "robots");
  if (contents.length === 0) {
    return ["no robots meta tag"];
  }
  return contents
    .filter((content) => !DECLARED_ROBOTS.has(content))
    .map((content) => `robots "${content}" is not a declared value`);
};

/** Reads the root head's public Knowledge marker, as the browser smoke does. */
export const classifyPublicKnowledgeHead = (
  html: string,
): "enabled" | "disabled" | "unexpected" => {
  const contents = headMetaContents(html, PUBLIC_KNOWLEDGE_META.name);
  if (contents.length === 0) {
    return "disabled";
  }
  return contents.every((content) => content === PUBLIC_KNOWLEDGE_META.content)
    ? "enabled"
    : "unexpected";
};

type PublicKnowledgeProbe =
  | { state: PublicKnowledgeState }
  | { state: "inconsistent"; detail: string };

/** API and web must agree on whether public Knowledge is enabled. */
export const resolvePublicKnowledgeState = ({
  apiStatus,
  webStatus,
  webState,
}: {
  apiStatus: number;
  webStatus: number;
  webState: "enabled" | "disabled" | "unexpected";
}): PublicKnowledgeProbe => {
  if (apiStatus !== 200 && apiStatus !== 404) {
    return {
      state: "inconsistent",
      detail: `public Knowledge API probe answered ${String(apiStatus)}`,
    };
  }
  if (webStatus !== 200) {
    return {
      state: "inconsistent",
      detail: `web probe answered ${String(webStatus)}`,
    };
  }
  if (webState === "unexpected") {
    return {
      state: "inconsistent",
      detail: "unexpected public Knowledge marker content",
    };
  }
  const apiEnabled = apiStatus === 200;
  if (apiEnabled !== (webState === "enabled")) {
    return {
      state: "inconsistent",
      detail: `API ${apiEnabled ? "enabled" : "disabled"}, web ${webState}`,
    };
  }
  return { state: apiEnabled ? "enabled" : "disabled" };
};

// ---------------------------------------------------------------------------
// Public ids and targets
// ---------------------------------------------------------------------------

const packListSchema = v.object({
  items: v.array(v.object({ id: v.string(), templateCount: v.number() })),
});
const packDetailSchema = v.object({
  templates: v.array(v.object({ id: v.string() })),
});
const starterListSchema = v.object({
  items: v.array(v.object({ id: v.string() })),
});

/** The first public pack that lists templates. */
export const firstPublicPackId = (payload: unknown): string | null => {
  const parsed = v.safeParse(packListSchema, payload);
  return parsed.success
    ? (parsed.output.items.find((pack) => pack.templateCount > 0)?.id ?? null)
    : null;
};

export const firstTemplateId = (payload: unknown): string | null => {
  const parsed = v.safeParse(packDetailSchema, payload);
  return parsed.success ? (parsed.output.templates.at(0)?.id ?? null) : null;
};

export const firstStarterId = (payload: unknown): string | null => {
  const parsed = v.safeParse(starterListSchema, payload);
  return parsed.success ? (parsed.output.items.at(0)?.id ?? null) : null;
};

type PublicIds = {
  packId: string;
  templateId: string;
  starterId: string;
};

/** Every target, fixed before any checked read. */
export const buildTargets = ({
  publicIds,
  publicKnowledge,
  toolEntry,
}: {
  publicIds: PublicIds | null;
  publicKnowledge: PublicKnowledgeState;
  toolEntry: string | null;
}): Target[] => {
  const segment = encodeURIComponent;
  const enabled = publicKnowledge === "enabled";
  const pages: Target[] = KNOWLEDGE_PAGE_PATHS.map((path) => ({
    path,
    responseClass: RESPONSE_CLASS.page,
    robots: enabled && path === "/knowledge/tools/contribute",
  }));
  if (toolEntry) {
    pages.push({
      path: `/knowledge/tools/${segment(toolEntry)}`,
      responseClass: RESPONSE_CLASS.page,
      robots: enabled,
    });
  }
  const publicJson = [
    `${PUBLIC_KNOWLEDGE_WEB}${TEMPLATE_PACKS}`,
    `${PUBLIC_KNOWLEDGE_WEB}${PLAYBOOK_STARTERS}`,
  ];
  if (enabled && publicIds) {
    const pack = `${PUBLIC_KNOWLEDGE_WEB}${TEMPLATE_PACKS}/${segment(publicIds.packId)}`;
    const template = `${pack}/templates/${segment(publicIds.templateId)}`;
    pages.push({
      path: `/knowledge/templates/catalogue/${segment(publicIds.packId)}/${segment(
        publicIds.templateId,
      )}`,
      responseClass: RESPONSE_CLASS.page,
      robots: true,
    });
    publicJson.push(
      pack,
      template,
      `${template}/preview`,
      `${PUBLIC_KNOWLEDGE_WEB}${PLAYBOOK_STARTERS}/${segment(publicIds.starterId)}`,
    );
  }
  return [
    ...pages,
    ...SIGNED_IN_PAGE_PATHS.map((path) => ({
      path,
      responseClass: RESPONSE_CLASS.accountPage,
    })),
    ...publicJson.map((path) => ({
      path,
      responseClass: RESPONSE_CLASS.publicJson,
    })),
    ...MEMBER_JSON_POLICY_PATHS.map((path) => ({
      path,
      responseClass: RESPONSE_CLASS.memberJson,
      cacheControl: MEMBER_JSON_CACHE_CONTROL,
    })),
  ];
};

// ---------------------------------------------------------------------------
// Build commits
// ---------------------------------------------------------------------------

const buildMarkerSchema = v.object({
  commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/iu)),
});

/** The commit a build marker reports, or null for none or a local build. */
export const buildCommit = (payload: unknown): string | null => {
  const parsed = v.safeParse(buildMarkerSchema, payload);
  return parsed.success ? parsed.output.commit.toLowerCase() : null;
};

/** Why the run must stop, when both origins report different commits. */
export const buildCommitMismatch = ({
  api,
  web,
}: {
  api: string | null;
  web: string | null;
}): string | null =>
  api !== null && web !== null && api !== web
    ? `web serves commit ${web}, API serves commit ${api}; ` +
      "rerun when both serve the same build"
    : null;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

type Observation = {
  path: string;
  responseClass: ResponseClass;
  attempt: number;
  status: number;
  cacheControl: string | null;
  contentType: string | null;
  xCache: string | null;
  age: string | null;
  pop: string | null;
  setCookie: boolean;
  robots: string[] | null;
  failures: string[];
};

type Config = {
  webUrl: string;
  apiUrl: string;
  edgeHeaders: Record<string, string>;
};

const trimBaseUrl = (value: string): string =>
  value.replace(/(?<!\/)\/+$/u, "");

const readConfig = (): Config => {
  const webUrl = process.env["E2E_WEB_URL"];
  const apiUrl = process.env["E2E_API_URL"];
  if (!webUrl || !apiUrl) {
    throw new ResponsePolicyError({
      message: "E2E_WEB_URL and E2E_API_URL are required",
    });
  }
  const edgeName = process.env["E2E_EDGE_HEADER_NAME"] ?? "";
  const edgeValue = process.env["E2E_EDGE_HEADER_VALUE"] ?? "";
  return {
    webUrl: trimBaseUrl(webUrl),
    apiUrl: trimBaseUrl(apiUrl),
    edgeHeaders: edgeName && edgeValue ? { [edgeName]: edgeValue } : {},
  };
};

/**
 * The script's one outbound boundary: every request goes to the deployment
 * named by E2E_WEB_URL or E2E_API_URL.
 */
const deploymentFetch = async (
  url: string,
  init: Omit<RequestInit, "signal">,
): Promise<Response> =>
  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- operator-run check against the deployment named by E2E_WEB_URL / E2E_API_URL
  await fetchWithTimeout(url, {
    ...init,
    redirect: "manual",
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

const errorMessage = (error: unknown): string => {
  const safeError = sanitizeErrorForOutput(error);
  return safeError instanceof Error ? safeError.message : String(safeError);
};

const createRun = (config: Config) => {
  const observations: Observation[] = [];
  const failures: string[] = [];

  const read = async (
    origin: string,
    path: string,
    accept: string,
  ): Promise<ResponseSnapshot> => {
    try {
      const response = await deploymentFetch(`${origin}${path}`, {
        method: "GET",
        headers: { ...config.edgeHeaders, accept },
      });
      return {
        status: response.status,
        headers: response.headers,
        body: await response.text(),
      };
    } catch (error) {
      failures.push(`GET ${origin}${path}: ${errorMessage(error)}`);
      return { status: 0, headers: new Headers(), body: "" };
    }
  };

  const observe = async (
    target: Target,
    publicKnowledge: PublicKnowledgeState,
    attempt: number,
  ): Promise<void> => {
    const snapshot = await read(
      config.webUrl,
      target.path,
      isPageClass(target.responseClass) ? "text/html" : "application/json",
    );
    const checkRobots =
      target.robots === true &&
      snapshot.status === 200 &&
      mediaType(snapshot.headers) === "text/html";
    const found = [
      ...evaluateStatus(
        { responseClass: target.responseClass, publicKnowledge },
        snapshot,
      ),
      ...evaluateCachePolicy(target, snapshot),
      ...(checkRobots ? evaluateRobots(snapshot.body) : []),
    ];
    observations.push({
      path: target.path,
      responseClass: target.responseClass,
      attempt,
      status: snapshot.status,
      cacheControl: snapshot.headers.get(CACHE_CONTROL_HEADER),
      contentType: snapshot.headers.get("content-type"),
      xCache: snapshot.headers.get("x-cache"),
      age: snapshot.headers.get("age"),
      pop: snapshot.headers.get("x-amz-cf-pop"),
      setCookie: snapshot.headers.has("set-cookie"),
      robots: checkRobots ? headMetaContents(snapshot.body, "robots") : null,
      failures: found,
    });
    for (const failure of found) {
      failures.push(`${target.path} (#${String(attempt)}): ${failure}`);
    }
  };

  return { observations, failures, read, observe };
};

const discoverPublicIds = async (
  run: ReturnType<typeof createRun>,
  apiUrl: string,
  packList: unknown,
): Promise<PublicIds | null> => {
  const packId = firstPublicPackId(packList);
  const starters = await run.read(
    apiUrl,
    `${PUBLIC_KNOWLEDGE_API}${PLAYBOOK_STARTERS}`,
    "application/json",
  );
  const starterId = firstStarterId(parseJson(starters.body));
  if (!packId || !starterId) {
    return null;
  }
  const pack = await run.read(
    apiUrl,
    `${PUBLIC_KNOWLEDGE_API}${TEMPLATE_PACKS}/${encodeURIComponent(packId)}`,
    "application/json",
  );
  const templateId = firstTemplateId(parseJson(pack.body));
  return templateId ? { packId, templateId, starterId } : null;
};

/** The build commit an origin reports; null when it reports none. */
const readBuildCommit = async (
  config: Config,
  url: string,
): Promise<string | null> => {
  try {
    const response = await deploymentFetch(url, {
      method: "GET",
      headers: { ...config.edgeHeaders, accept: "application/json" },
    });
    return buildCommit(parseJson(await response.text()));
  } catch {
    // Outages surface in the checks themselves.
    return null;
  }
};

const main = async (): Promise<boolean> => {
  const config = readConfig();
  const [apiCommit, webCommit] = await Promise.all([
    readBuildCommit(config, `${config.apiUrl}${API_BUILD_PATH}`),
    readBuildCommit(config, `${config.webUrl}${WEB_BUILD_PATH}`),
  ]);
  const mismatch = buildCommitMismatch({ api: apiCommit, web: webCommit });
  if (mismatch !== null) {
    throw new ResponsePolicyError({ message: mismatch });
  }
  const run = createRun(config);

  const apiProbe = await run.read(
    config.apiUrl,
    `${PUBLIC_KNOWLEDGE_API}${TEMPLATE_PACKS}`,
    "application/json",
  );
  const webProbe = await run.read(config.webUrl, "/", "text/html");
  const probe = resolvePublicKnowledgeState({
    apiStatus: apiProbe.status,
    webStatus: webProbe.status,
    webState: classifyPublicKnowledgeHead(webProbe.body),
  });
  if (probe.state === "inconsistent") {
    run.failures.push(`public Knowledge state: ${probe.detail}`);
  }
  const publicKnowledge: PublicKnowledgeState =
    probe.state === "enabled" ? "enabled" : "disabled";

  const publicIds =
    publicKnowledge === "enabled"
      ? await discoverPublicIds(run, config.apiUrl, parseJson(apiProbe.body))
      : null;
  if (publicKnowledge === "enabled" && !publicIds) {
    run.failures.push(
      "public Knowledge is enabled but lists no pack, template or starter",
    );
  }
  const toolEntry = loadCatalogue().at(0)?.slug ?? null;
  const targets = buildTargets({ publicIds, publicKnowledge, toolEntry });

  for (const target of targets) {
    await run.observe(target, publicKnowledge, 1);
    // Pages and member JSON are read twice: a response declared no-store
    // must not come from a cache on an immediate repeat either.
    if (target.responseClass !== RESPONSE_CLASS.publicJson) {
      await run.observe(target, publicKnowledge, 2);
    }
  }

  const passed = run.failures.length === 0;
  process.stdout.write(
    `${JSON.stringify(
      {
        target: config.webUrl,
        result: passed ? "pass" : "fail",
        commit: apiCommit ?? webCommit,
        publicKnowledge,
        publicIds,
        failures: run.failures,
        observations: run.observations,
      },
      null,
      2,
    )}\n`,
  );
  return passed;
};

if (import.meta.main) {
  try {
    process.exit((await main()) ? 0 : 1);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}
