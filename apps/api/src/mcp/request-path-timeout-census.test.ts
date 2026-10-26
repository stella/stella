import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  MCP_TOOL_LATENCY_BUDGET_OVERRIDES,
  mcpToolLatencyBudgetMs,
} from "@/api/mcp/tool-latency-budgets";
import type { McpToolLatencyBudgetKey } from "@/api/mcp/tool-latency-budgets";

/**
 * Every timeout a request waits on, held against that request's budget.
 *
 * A dependency timeout longer than the request it serves does not fail the
 * request: the request waits it out and answers late, which neither an error
 * alarm nor a correctness canary sees. So every timeout on an MCP tool path,
 * or on a public corpus route the tools share, is declared here with the
 * tools and route classes that reach it, and must be shorter than each of
 * their budgets, unless the site clamps to the request's remaining budget
 * (`requestBoundedTimeoutMs`, including the enclosing transaction deadline)
 * or does not hold the request at all.
 *
 * The scan is the lint half: a new `timeoutMs`, `deadlineMs`,
 * `AbortSignal.timeout(...)` or statement timeout under these roots fails
 * until it is declared, so a new wait cannot land without its budget.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

/** Where an MCP tool call, or a public corpus route it shares, waits. */
const REQUEST_PATH_ROOTS = [
  "apps/api/src/mcp",
  "apps/api/src/handlers/case-law/decisions",
  "apps/api/src/handlers/legislation",
  "apps/api/src/handlers/documents/compare.ts",
  "apps/api/src/lib/legal-search/corpus-index-client.ts",
  "apps/api/src/lib/legal-search/corpus-index-pagination.ts",
  "apps/api/src/lib/public-law-read-db.ts",
] as const;

/** The public corpus route classes (`public-corpus-policy.ts`). */
type PublicCorpusRouteClass = "browse" | "search" | "aggregate" | "sitemap";

type CensusEntry = {
  /** `<repo path>#<budget expression as written>`. */
  site: string;
  why: string;
  /** Only for an expression the census cannot read from source. */
  budgetMs?: number;
} & (
  | {
      path: "request";
      /** The MCP tools that wait on the site; "every" for the shared gateway. */
      tools?: readonly McpToolLatencyBudgetKey[] | "every";
      /** The public corpus route classes that wait on it. */
      http?: readonly PublicCorpusRouteClass[];
      /**
       * `own`: the site's own budget must be shorter than every listed
       * tool's. `request`: a timeout or enclosing transaction is bounded by
       * `requestBoundedTimeoutMs`, so it cannot outwait the tool.
       */
      bound: "own" | "request";
      /** What the caller gets when it expires. */
      onExpiry: "degrades" | "fails-fast";
    }
  | { path: "off-request" }
);

// --- Source scan --------------------------------------------------------------

const listSourceFiles = (root: string): string[] => {
  const absolute = path.join(REPO_ROOT, root);
  if (statSync(absolute).isFile()) {
    return [root];
  }
  return [...new Bun.Glob("**/*.ts").scanSync(absolute)]
    .filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.includes("__snapshots__") &&
        !file.includes("/test-fixtures/"),
    )
    .map((file) => path.posix.join(root, file))
    .filter((file) => !NOT_SCANNED.has(file))
    .toSorted();
};

const CLOSERS: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

/** The expression starting at `start`, up to its end at bracket depth zero. */
const readExpression = (text: string, start: number): string => {
  const stack: string[] = [];
  let index = start;
  for (; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    const opener = CLOSERS[char];
    if (opener !== undefined) {
      if (stack.length === 0) {
        break;
      }
      stack.pop();
      continue;
    }
    if (stack.length === 0 && (char === "," || char === ";" || char === "\n")) {
      break;
    }
  }
  return text.slice(start, index).replaceAll(/\s+/gu, " ").trim();
};

/**
 * A wait being set: an option or parameter default naming a timeout,
 * deadline or sub-budget, an `AbortSignal.timeout(...)`, a statement guard.
 */
// A property colon follows its name directly; a ternary's ` : ` does not.
const SITE_PATTERNS = [
  /\b(?:timeoutMs|deadlineMs|budgetMs|commandTimeoutMs|requestTimeoutMs|statementTimeoutMs|transactionTimeoutMs):\s*/gu,
  /\b(?:timeoutMs|commandTimeoutMs)\s*=(?![=>])\s*/gu,
  /\bAbortSignal\.timeout\(\s*/gu,
] as const;

/** Shorthand properties (`{ timeoutMs }`) pass a caller's value through. */
const SHORTHAND_PATTERN = /[{,]\s*(timeoutMs|deadlineMs|budgetMs)\s*[,}]/gu;

/** The budget table itself: its `budgetMs` entries are budgets, not waits. */
const NOT_SCANNED = new Set(["apps/api/src/mcp/tool-latency-budgets.ts"]);
const STATEMENT_GUARD_PATTERN = /\["statement_timeout",\s*"(\d+)(ms|s)"\]/gu;

/** A type position, not a value: `timeoutMs: number`. */
const isTypeAnnotation = (expression: string): boolean =>
  /^(?:number|undefined|null|string|boolean)\b/u.test(expression) ||
  expression.length === 0;

const isCommentLine = (text: string, offset: number): boolean => {
  const lineStart = text.lastIndexOf("\n", offset) + 1;
  const prefix = text.slice(lineStart, offset).trimStart();
  return prefix.startsWith("//") || prefix.startsWith("*");
};

const scanSites = (file: string): string[] => {
  const text = readFileSync(path.join(REPO_ROOT, file), "utf-8");
  const sites = new Set<string>();
  for (const pattern of SITE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (isCommentLine(text, match.index)) {
        continue;
      }
      const expression = readExpression(text, match.index + match[0].length);
      if (!isTypeAnnotation(expression)) {
        sites.add(`${file}#${expression}`);
      }
    }
  }
  for (const match of text.matchAll(SHORTHAND_PATTERN)) {
    if (!isCommentLine(text, match.index)) {
      sites.add(`${file}#${match[1] ?? ""}`);
    }
  }
  for (const match of text.matchAll(STATEMENT_GUARD_PATTERN)) {
    sites.add(`${file}#statement_timeout ${match[1] ?? ""}${match[2] ?? ""}`);
  }
  return [...sites];
};

// --- Static budget resolution -----------------------------------------------

const readSource = (file: string): string =>
  readFileSync(path.join(REPO_ROOT, file), "utf-8");

/** A repository path for an `@/api/` or relative specifier; packages are out of scope. */
const importBase = (file: string, specifier: string): string | undefined => {
  if (specifier.startsWith("@/api/")) {
    return path.posix.join("apps/api/src", specifier.slice("@/api/".length));
  }
  if (specifier.startsWith(".")) {
    return path.posix.join(path.posix.dirname(file), specifier);
  }
  return undefined;
};

const resolveImport = (file: string, specifier: string): string | undefined => {
  const base = importBase(file, specifier);
  if (base === undefined) {
    return undefined;
  }
  return [`${base}.ts`, path.posix.join(base, "index.ts")].find((candidate) =>
    existsSync(path.join(REPO_ROOT, candidate)),
  );
};

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, (special) => `\\${special}`);

/** The file that declares `name`: this one, or the module it imports it from. */
const declaringFile = (file: string, name: string): string | undefined => {
  const text = readSource(file);
  if (new RegExp(String.raw`\bconst ${escapeRegExp(name)}\b`, "u").test(text)) {
    return file;
  }
  for (const match of text.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"([^"]+)"/gu,
  )) {
    const names = (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().split(/\s+as\s+/u))
      .filter((parts) => (parts.at(-1) ?? "") === name)
      .map((parts) => parts.at(0) ?? "");
    if (names.length > 0) {
      const target = resolveImport(file, match[2] ?? "");
      return target === undefined ? undefined : declaringFile(target, name);
    }
  }
  return undefined;
};

/** A small arithmetic evaluator: numbers, + - * /, parentheses. */
const evaluateArithmetic = (source: string): number | undefined => {
  const tokens = source.match(/\d+(?:\.\d+)?|[+\-*/()]/gu) ?? [];
  if (tokens.join("") !== source.replaceAll(/\s+/gu, "")) {
    return undefined;
  }
  let position = 0;
  const peek = () => tokens[position];
  const factor = (): number => {
    const token = tokens[position++];
    if (token === "(") {
      const value = sum();
      position++;
      return value;
    }
    if (token === "-") {
      return -factor();
    }
    return Number(token);
  };
  const product = (): number => {
    let value = factor();
    while (peek() === "*" || peek() === "/") {
      value = tokens[position++] === "*" ? value * factor() : value / factor();
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (peek() === "+" || peek() === "-") {
      value =
        tokens[position++] === "+" ? value + product() : value - product();
    }
    return value;
  };
  const value = sum();
  return position === tokens.length && Number.isFinite(value)
    ? value
    : undefined;
};

/** The milliseconds a budget expression holds, when source alone says. */
const resolveBudgetMs = (
  file: string,
  expression: string,
  depth = 0,
): number | undefined => {
  if (depth > 8) {
    return undefined;
  }
  // A request clamp can only shorten a positive timeout; its argument is
  // still the upper bound the public HTTP route budget must cover.
  const requestClamp = "requestBoundedTimeoutMs(";
  if (expression.startsWith(requestClamp) && expression.endsWith(")")) {
    const upperBound = resolveBudgetMs(
      file,
      expression.slice(requestClamp.length, -1),
      depth + 1,
    );
    return upperBound !== undefined && upperBound > 0 ? upperBound : undefined;
  }
  const statement = /^statement_timeout (\d+)(ms|s)$/u.exec(expression);
  if (statement !== null) {
    return Number(statement[1]) * (statement[2] === "s" ? 1000 : 1);
  }
  const replaced = expression.replaceAll(
    /\b([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\b/gu,
    (whole, name: string, property: string | undefined) => {
      const owner = declaringFile(file, name);
      if (owner === undefined) {
        return whole;
      }
      const text = readSource(owner);
      const declaration = new RegExp(
        String.raw`\bconst ${escapeRegExp(name)}\b[^=]*=\s*`,
        "u",
      ).exec(text);
      if (declaration === null) {
        return whole;
      }
      const start = declaration.index + declaration[0].length;
      if (property === undefined) {
        const value = resolveBudgetMs(
          owner,
          readExpression(text, start).replace(/\s+as const$/u, ""),
          depth + 1,
        );
        return value === undefined ? whole : String(value);
      }
      const member = new RegExp(
        String.raw`\b${escapeRegExp(property)}\s*:\s*`,
        "u",
      ).exec(text.slice(start));
      if (member === null) {
        return whole;
      }
      const value = resolveBudgetMs(
        owner,
        readExpression(text, start + member.index + member[0].length),
        depth + 1,
      );
      return value === undefined ? whole : String(value);
    },
  );
  return evaluateArithmetic(replaced.replaceAll("_", ""));
};

// --- The census -----------------------------------------------------------------

const CORPUS_SEARCH_TOOLS = [
  "search",
  "search_case_law",
  "search_legislation",
] as const satisfies readonly McpToolLatencyBudgetKey[];

const PUBLIC_LAW_READ_TOOLS = [
  ...CORPUS_SEARCH_TOOLS,
  "fetch",
  "case_law_coverage",
  "read_case_law_decision",
  "read_case_law_citations",
  "read_case_law_decision_blocks",
  "open_case_law_decision",
  "resolve_case_law_decision",
  "read_statute",
  "read_statute_provisions",
  "read_provision_history",
  "preview_cited_provision",
  "resolve_law_citation",
] as const satisfies readonly McpToolLatencyBudgetKey[];

const CENSUS: readonly CensusEntry[] = [
  // --- MCP tool modules -------------------------------------------------------
  {
    site: "apps/api/src/mcp/case-law-court-filter.ts#COURT_NAMES_READ_BUDGET_MS",
    path: "request",
    tools: ["search_case_law"],
    bound: "own",
    onExpiry: "degrades",
    why: "Reads the stored courts a court filter is matched against; without them the filter runs as sent and the search reports filter_unread.",
  },
  {
    site: "apps/api/src/mcp/gateway/rate-limit.ts#REDIS_COMMAND_TIMEOUT_MS",
    path: "request",
    tools: ["external_mcp"],
    bound: "own",
    onExpiry: "degrades",
    why: "Counts a gateway call against its rate limit; a slow Redis falls back to the in-process counter.",
  },
  {
    site: "apps/api/src/mcp/document-file-upload.ts#60_000",
    path: "request",
    tools: ["upload_document_version"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "Downloads the host's file and uploads it to storage, each transfer bounded on its own.",
  },
  {
    site: "apps/api/src/mcp/file-comparison-links-tool.ts#TRANSFER_TIMEOUT_MS",
    path: "request",
    tools: ["prepare_file_comparison_from_links"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "Transfers each linked file into storage before the comparison is prepared.",
  },
  {
    site: "apps/api/src/mcp/file-comparison-run.ts#DOCUMENT_COMPARE_READ_TIMEOUT_MS",
    path: "request",
    tools: ["compare_documents"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "Reads an uploaded comparison file back from storage.",
  },
  {
    site: "apps/api/src/mcp/stella-tools.ts#LIMITS.docxMarkdownConversionTimeoutMs",
    path: "request",
    tools: ["read_content_across_matters"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "Reads a stored DOCX and converts it to Markdown for the reply.",
  },
  {
    site: "apps/api/src/mcp/template-tools.ts#SAVE_FILLED_TEMPLATE_RENDER_TIMEOUT_MS",
    path: "request",
    tools: ["save_filled_template"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "Renders the filled document before it is saved.",
  },
  {
    site: "apps/api/src/mcp/template-tools.ts#HOST_FILE_DOWNLOAD_TIMEOUT_MS",
    path: "request",
    tools: ["create_template"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "Downloads the template file the host shared.",
  },
  {
    site: "apps/api/src/mcp/template-tools.ts#PREVIEW_TEMPLATE_CONDITIONS_TIMEOUT_MS",
    path: "request",
    tools: ["preview_template_conditions"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "Asks a model to evaluate the template's conditions.",
  },
  {
    site: "apps/api/src/mcp/server-core.ts#mcpToolLatencyBudgetMs(metricToolName)",
    path: "off-request",
    why: "Opens the request latency scope itself, with the tool's own budget.",
  },
  {
    site: "apps/api/src/mcp/static-cli-metadata.ts#DOCUMENT_COMPARE_REQUEST_TIMEOUT_MS",
    path: "off-request",
    why: "The generated CLI's client transport deadline; the server does not wait on it.",
  },
  {
    site: "apps/api/src/mcp/static-cli-metadata.ts#330_000",
    path: "off-request",
    why: "The generated CLI's client transport deadline; the server does not wait on it.",
  },
  // --- Public corpus handlers the tools share --------------------------------
  {
    site: "apps/api/src/handlers/case-law/decisions/document-on-demand.ts#requestBoundedTimeoutMs(READ_BUDGET_MS)",
    path: "request",
    tools: ["fetch", "read_case_law_decision"],
    http: ["browse"],
    bound: "request",
    onExpiry: "degrades",
    why: "Waits for pending decision text within the request's remaining budget; past it the decision answers without its text, marked pending.",
  },
  {
    site: "apps/api/src/handlers/case-law/decisions/document-on-demand-deps.ts#15_000",
    path: "off-request",
    why: "Records the fetch request inside the read's own READ_BUDGET_MS wait, which the read stops at; the recording finishes for the next reader.",
  },
  {
    site: "apps/api/src/handlers/case-law/decisions/document-on-demand-deps.ts#DOCUMENT_FETCH_BUDGET_MS",
    path: "off-request",
    why: "The publisher download a read starts and stops waiting for at READ_BUDGET_MS; it keeps running for the next reader.",
  },
  {
    site: "apps/api/src/handlers/case-law/decisions/dev-reparse.ts#FETCH_TIMEOUT_MS",
    path: "off-request",
    why: "A local-development route, not mounted in deployments.",
  },
  {
    site: "apps/api/src/handlers/case-law/decisions/search-expand.ts#4000",
    path: "off-request",
    why: "The authenticated web route /case/decisions/search/expand; neither an MCP tool nor a public corpus route reaches it.",
  },
  {
    site: "apps/api/src/handlers/case-law/decisions/search-refine.ts#CASE_LAW_REFINE_TIMEOUT_MS",
    path: "off-request",
    why: "The authenticated web route /case/decisions/search/refine; neither an MCP tool nor a public corpus route reaches it.",
  },
  {
    site: "apps/api/src/handlers/legislation/ingestion.ts#adapter.maxCycleMs ?? MAX_CYCLE_MS",
    path: "off-request",
    why: "The legislation ingestion cycle, run by the background worker.",
  },
  {
    site: "apps/api/src/handlers/legislation/ingestion.ts#pageTimeoutMs",
    path: "off-request",
    why: "One legislation ingestion page fetch, run by the background worker.",
  },
  // --- Document comparison, dispatched synchronously by compare_documents ----
  {
    site: "apps/api/src/handlers/documents/compare.ts#DOCUMENT_COMPARE_REQUEST_TIMEOUT_MS",
    path: "off-request",
    why: "The route's own declared request deadline, the budget compare_documents mirrors.",
  },
  {
    site: "apps/api/src/handlers/documents/compare.ts#DOCUMENT_COMPARE_TIMEOUT_MS",
    path: "request",
    tools: ["compare_documents"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "One comparison service call.",
  },
  {
    site: "apps/api/src/handlers/documents/compare.ts#DOCUMENT_COMPARE_READ_TIMEOUT_MS",
    path: "request",
    tools: ["compare_documents"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "Reads a compared document's bytes from storage.",
  },
  {
    site: "apps/api/src/handlers/documents/compare.ts#DOCUMENT_COMPARE_DEADLINE_MS",
    path: "request",
    tools: ["compare_documents"],
    bound: "own",
    onExpiry: "fails-fast",
    why: "The whole comparison run, inside the route's request deadline.",
  },
  // --- Corpus index client and public-law reads -------------------------------
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#requestBoundedTimeoutMs(request.timeoutMs)",
    path: "request",
    tools: PUBLIC_LAW_READ_TOOLS,
    bound: "request",
    onExpiry: "fails-fast",
    why: "The clamp every corpus request passes: its own timeout, or what is left of the request's budget.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#request.timeoutMs",
    path: "request",
    tools: PUBLIC_LAW_READ_TOOLS,
    bound: "request",
    onExpiry: "fails-fast",
    why: "The corpus request's timeout after the clamp, passed to the fetch.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#Math.min(timeoutMs, CORPUS_INDEX_SEARCH_TIMEOUT_MS)",
    path: "request",
    tools: CORPUS_SEARCH_TOOLS,
    bound: "request",
    onExpiry: "fails-fast",
    why: "A corpus search with a caller's shorter timeout, clamped again to the request.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#CORPUS_INDEX_SEARCH_TIMEOUT_MS",
    path: "request",
    tools: CORPUS_SEARCH_TOOLS,
    http: ["search", "browse"],
    bound: "request",
    onExpiry: "fails-fast",
    why: "A corpus search; inside a tool call it gives up at the tool's budget.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#CORPUS_INDEX_AGGREGATION_TIMEOUT_MS",
    path: "request",
    tools: ["case_law_coverage", ...CORPUS_SEARCH_TOOLS],
    http: ["aggregate", "browse", "search"],
    bound: "request",
    onExpiry: "fails-fast",
    why: "Facet counts; inside a tool call they give up at the tool's budget.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#ADMIN_TIMEOUT_MS",
    path: "off-request",
    why: "Index administration (create, describe, delete) by the corpus workers.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#CORPUS_INDEX_INGEST_TIMEOUT_MS",
    path: "off-request",
    why: "Ingest by the corpus projection worker.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#corpusIndexCommittedIngestTimeoutMs(commitTimeoutSecs)",
    path: "off-request",
    why: "Committed ingest by the corpus projection worker.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#remainingBudget()",
    path: "off-request",
    why: "The delete-settlement scan of the corpus projection worker.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-client.ts#timeoutMs",
    path: "off-request",
    why: "The search liveness probe, run by health checks with their own timeout.",
  },
  {
    site: "apps/api/src/lib/legal-search/corpus-index-pagination.ts#remainingMs",
    path: "request",
    tools: CORPUS_SEARCH_TOOLS,
    bound: "request",
    onExpiry: "fails-fast",
    why: "Page highlighting shares one search deadline, itself clamped to the request.",
  },
  {
    site: "apps/api/src/lib/public-law-read-db.ts#statement_timeout 30s",
    path: "request",
    tools: PUBLIC_LAW_READ_TOOLS,
    http: ["browse", "search", "aggregate", "sitemap"],
    bound: "request",
    onExpiry: "fails-fast",
    why: "The read's statement cap remains independent; the enclosing transaction ends at the request's deadline as a whole.",
  },
  {
    site: "apps/api/src/lib/public-law-read-db.ts#statementCapMs",
    path: "request",
    tools: PUBLIC_LAW_READ_TOOLS,
    bound: "request",
    onExpiry: "fails-fast",
    why: "The route-owned statement cap, inside a transaction bounded by the request's remaining budget.",
  },
  {
    site: "apps/api/src/lib/public-law-read-db.ts#requestDeadlineMs",
    path: "request",
    tools: PUBLIC_LAW_READ_TOOLS,
    bound: "request",
    onExpiry: "fails-fast",
    why: "The transaction-wide deadline: statement_timeout restarts per statement, so transaction_timeout ends the whole read at the request's deadline.",
  },
];

// --- Checks ---------------------------------------------------------------------

const scanned = REQUEST_PATH_ROOTS.flatMap(listSourceFiles).flatMap(scanSites);
const declared = new Map(CENSUS.map((entry) => [entry.site, entry]));

const siteFile = (site: string): string => site.slice(0, site.indexOf("#"));
const siteExpression = (site: string): string =>
  site.slice(site.indexOf("#") + 1);

const budgetOf = (entry: CensusEntry): number | undefined =>
  entry.budgetMs ??
  resolveBudgetMs(siteFile(entry.site), siteExpression(entry.site));

const HTTP_CLASS_BUDGET_MS = (routeClass: PublicCorpusRouteClass) =>
  resolveBudgetMs(
    "apps/api/src/db/shared-pool-timeouts.ts",
    `PUBLIC_READ_STATEMENT_TIMEOUT_MS.${routeClass}`,
  );

const toolsOf = (
  tools: readonly McpToolLatencyBudgetKey[] | "every" | undefined,
): readonly string[] =>
  tools === "every"
    ? ["unknown", ...Object.keys(MCP_TOOL_LATENCY_BUDGET_OVERRIDES)]
    : (tools ?? []);

/** Each own-budget wait at or over the budget of a tool that reaches it. */
const waitsOverToolBudget = (entries: readonly CensusEntry[]): string[] =>
  entries.flatMap((entry) => {
    if (entry.path !== "request" || entry.bound !== "own") {
      return [];
    }
    const budgetMs = budgetOf(entry) ?? Number.POSITIVE_INFINITY;
    return toolsOf(entry.tools)
      .filter((tool) => budgetMs >= mcpToolLatencyBudgetMs(tool))
      .map(
        (tool) =>
          `${entry.site} waits ${String(budgetMs)} ms; ${tool} has ${String(mcpToolLatencyBudgetMs(tool))} ms`,
      );
  });

describe("request-path timeout census", () => {
  test.each(["0", "-1", "request.timeoutMs"])(
    "does not treat an unbounded request clamp as a finite HTTP bound: %s",
    (argument) => {
      expect(
        resolveBudgetMs(
          "apps/api/src/handlers/case-law/decisions/document-on-demand.ts",
          `requestBoundedTimeoutMs(${argument})`,
        ),
      ).toBeUndefined();
    },
  );

  test("declares every timeout under the request-path roots", () => {
    expect(scanned.filter((site) => !declared.has(site))).toEqual([]);
  });

  test("declares no site the scan no longer finds", () => {
    const found = new Set(scanned);
    expect(
      CENSUS.map(({ site }) => site).filter((site) => !found.has(site)),
    ).toEqual([]);
  });

  test("reads every budget a check compares, from source unless it cannot", () => {
    for (const entry of CENSUS) {
      if (
        entry.path === "off-request" ||
        (entry.bound === "request" && entry.http === undefined)
      ) {
        continue;
      }
      const resolved = resolveBudgetMs(
        siteFile(entry.site),
        siteExpression(entry.site),
      );
      // A declared number only stands in for an expression source cannot
      // read; a readable one must not be restated, or the two could drift.
      expect({ site: entry.site, resolved, declared: entry.budgetMs }).toEqual({
        site: entry.site,
        resolved: entry.budgetMs === undefined ? expect.any(Number) : undefined,
        declared: entry.budgetMs,
      });
    }
  });

  test("keeps every own-budget wait shorter than each tool's latency budget", () => {
    expect(waitsOverToolBudget(CENSUS)).toEqual([]);
  });

  test("names a wait that outlasts a tool's budget", () => {
    // The shape that lets a fast tool answer late: a 10 s wait under a tool
    // whose whole call has less.
    expect(
      waitsOverToolBudget([
        {
          site: "apps/api/src/mcp/example.ts#10_000",
          path: "request",
          tools: ["search_legislation", "read_statute"],
          bound: "own",
          onExpiry: "fails-fast",
          why: "A synthetic wait longer than both tools' budgets.",
        },
      ]),
    ).toEqual([
      "apps/api/src/mcp/example.ts#10_000 waits 10000 ms; search_legislation has 8000 ms",
      "apps/api/src/mcp/example.ts#10_000 waits 10000 ms; read_statute has 2000 ms",
    ]);
  });

  test("bounds a request-clamped site by the request in its own file", () => {
    for (const entry of CENSUS) {
      if (entry.path === "request" && entry.bound === "request") {
        expect({
          site: entry.site,
          clamps: readSource(siteFile(entry.site)).includes(
            "requestBoundedTimeoutMs(",
          ),
        }).toEqual({ site: entry.site, clamps: true });
      }
    }
  });

  test("keeps every wait within its public corpus route class budget", () => {
    const over = CENSUS.flatMap((entry) => {
      if (entry.path !== "request") {
        return [];
      }
      const budgetMs = budgetOf(entry) ?? Number.POSITIVE_INFINITY;
      return (entry.http ?? [])
        .filter(
          (routeClass) =>
            budgetMs > (HTTP_CLASS_BUDGET_MS(routeClass) ?? Number.NaN),
        )
        .map((routeClass) => `${entry.site} on ${routeClass}`);
    });
    expect(over).toEqual([]);
  });

  test("names a reason for every declaration", () => {
    expect(CENSUS.filter(({ why }) => why.trim().length < 20)).toEqual([]);
  });
});
