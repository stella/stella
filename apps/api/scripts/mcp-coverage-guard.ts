// MCP coverage guard (ratcheted).
//
// Companion to the required `mcp` disposition on every safe-handler config
// (`apps/api/src/lib/api-handlers.ts`). The type system already forces every
// endpoint to declare an `McpExposure`; this runtime guard adds the checks a
// type cannot express:
//
//   1. every enumerated endpoint config actually carries an `mcp` disposition
//      with a valid `type` (defense-in-depth against a bypassed type);
//   2. every `tool`/`covered` reference names a real static MCP tool;
//   3. no static MCP tool is orphaned — each is reachable through a
//      `type: "tool"` endpoint, a `type: "covered"` endpoint, or a documented
//      entry in TOOLS_WITHOUT_ENUMERABLE_ENDPOINT (inline-in-routes or static
//      tools the module glob cannot reach);
//   4. a ratcheted baseline of `pending` endpoints that can only shrink. The
//      baseline is now empty, so any `pending` endpoint fails as a new gap.
//   5. a hidden-endpoint invariant: per file, the number of `createSafe*Handler`
//      factory call sites must equal the number of `{ config, handler }` exports
//      the guard could enumerate (plus a pinned inline count for allowlisted
//      files). A factory call whose result is never exported as `{ config,
//      handler }` — inline in a route file, or assigned to a non-exported local —
//      would otherwise carry an `mcp` disposition the ratchet never sees.
//
// Enumeration is by module glob + dynamic import of every `{ config, handler }`
// export a handler module exposes (the default export and any named exports),
// NOT Elysia route introspection: the `mcp` field lives on the endpoint config
// and is never threaded into the route wiring, so the composed app cannot see
// it. Route wiring itself stays typecheck-enforced separately. An endpoint's
// identifier is its repo-relative module path for the default export, or
// `path#exportName` for a named export. Endpoints defined inline in a route file
// (not exported as `{ config, handler }`) are typecheck-enforced for `mcp` but
// not enumerated here; those files are pinned in INLINE_ENDPOINT_ALLOWLIST with
// their exact inline call count so a new inline endpoint fails check (5), and the
// few inline endpoints that back a tool are pinned in
// TOOLS_WITHOUT_ENUMERABLE_ENDPOINT so the orphan check stays honest.
//
// Modes:
//   bun apps/api/scripts/mcp-coverage-guard.ts                 CI gate (exit 1 on failure)
//   bun apps/api/scripts/mcp-coverage-guard.ts --write-baseline regenerate the pending baseline
//   bun apps/api/scripts/mcp-coverage-guard.ts --self-test      prove the ratchet detectors fire
//
// CI-only by design (it imports the handler graph): wired into
// `.github/workflows/ci.yml` and `bun run verify`, not oxlint.

import { panic } from "better-result";
import path from "node:path";

// Repo root resolved from this script's location so identifiers are stable
// regardless of the process working directory.
const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "../../..");
const HANDLERS_GLOB = "apps/api/src/handlers/**/*.ts";
const BASELINE_PATH = path.resolve(
  REPO_ROOT,
  "apps/api/mcp-coverage-baseline.json",
);

const EXPOSURE_TYPES = ["tool", "covered", "internal", "pending"] as const;
type ExposureType = (typeof EXPOSURE_TYPES)[number];

/**
 * Only import files that textually contain a safe-handler factory call. The
 * handlers tree also holds pure helpers and standalone CLI scripts (e.g.
 * case-law/seed-court-weights.ts, which runs a DB seed and process.exit at
 * module top level); importing those would execute their side effects and
 * can kill the guard process. Files without a factory call cannot define an
 * endpoint config, so skipping them without importing is sound.
 *
 * Global so `String.prototype.match` can count call sites per file for the
 * hidden-endpoint invariant. The trailing `[<(]` excludes bare identifier
 * mentions (imports, re-exports) and only matches a call or generic
 * instantiation, so an `import { createSafeHandler }` line is never counted.
 */
const SAFE_HANDLER_CALL_PATTERN =
  /createSafe(?:Root|Session|Token|Public)?Handler[<(]/gu;

/**
 * Files that legitimately define endpoints inline (via a `createSafe*Handler`
 * call whose result is mounted directly into an Elysia instance, never exported
 * as a `{ config, handler }` module) rather than as an enumerable export. Each
 * entry pins the exact number of inline factory call sites so the
 * hidden-endpoint invariant still fails if one more inline endpoint is added.
 * These are the route files where `no-inline-endpoint-in-routes` is disabled or
 * does not run (their names do not match the lint rule's `routes.ts`/`*route.ts`
 * globs). The `mcp` disposition on each inline endpoint stays typecheck-enforced;
 * only enumeration into the ratchet is waived.
 */
const INLINE_ENDPOINT_ALLOWLIST: Record<string, number> = {
  "apps/api/src/handlers/case-law/public-routes.ts": 7,
  "apps/api/src/handlers/case-law/routes.ts": 5,
  "apps/api/src/handlers/files/routes.ts": 4,
  "apps/api/src/handlers/legislation/corpus-routes.ts": 2,
  "apps/api/src/handlers/search/routes.ts": 5,
  "apps/api/src/handlers/tasks/my-tasks-route.ts": 1,
  "apps/api/src/handlers/time-entries/routes.ts": 3,
  "apps/api/src/handlers/workspaces/routes.ts": 6,
};

/**
 * Static MCP tools with no default-exported endpoint module for the glob to
 * enumerate. Each entry is a deliberate, reviewed waiver of the orphan check
 * with the reason the tool is unreachable by module enumeration. Keep this in
 * sync with the actual tool backings; a stale entry (a name no longer in the
 * registry) fails the guard.
 */
const TOOLS_WITHOUT_ENUMERABLE_ENDPOINT: Record<string, string> = {
  search:
    "inline endpoint: apps/api/src/handlers/search/routes.ts POST /search",
  search_across_matters:
    "inline endpoint: apps/api/src/handlers/search/routes.ts POST /search (same backing as `search`)",
  search_case_law:
    "inline endpoint: apps/api/src/handlers/case-law/public-routes.ts POST /case/decisions/search",
  read_case_law_decision:
    "inline endpoint: apps/api/src/handlers/case-law/public-routes.ts GET /case/decisions/:decisionId",
  read_content_across_matters:
    "no dedicated endpoint: MCP handler reads extractedContent directly (apps/api/src/mcp/stella-tools.ts)",
  fetch:
    "no dedicated endpoint: compat alias, MCP handler reads extractedContent directly (apps/api/src/mcp/compat-tools.ts)",
  send_feedback:
    "no dedicated endpoint: MCP-only tool, files feedback via a prefilled GitHub issue URL or the email transport (apps/api/src/mcp/feedback-tools.ts)",
};

export type EnumeratedEndpoint = {
  id: string;
  mcp: unknown;
};

export type ParsedExposure =
  | { type: "tool"; name: string }
  | { type: "covered"; by: string }
  | { type: "internal"; reason: string }
  | { type: "pending" }
  | { type: "invalid"; raw: unknown };

/** Repo-relative identifier for an endpoint module (stable across machines). */
export const toEndpointIdentifier = (
  absPath: string,
  repoRoot: string,
): string => {
  const normalizedRoot = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return absPath.startsWith(normalizedRoot)
    ? absPath.slice(normalizedRoot.length)
    : absPath;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Narrow an unknown default export to an endpoint definition shape. */
export const isEndpointModule = (
  value: unknown,
): value is { config: Record<string, unknown>; handler: unknown } => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["handler"] === "function" && isRecord(value["config"]);
};

/** Parse a config's `mcp` value into a discriminated result the guard checks. */
export const parseExposure = (mcp: unknown): ParsedExposure => {
  if (!isRecord(mcp)) {
    return { type: "invalid", raw: mcp };
  }
  const type = mcp["type"];
  if (type === "pending") {
    return { type: "pending" };
  }
  const name = mcp["name"];
  if (type === "tool" && typeof name === "string") {
    return { type: "tool", name };
  }
  const by = mcp["by"];
  if (type === "covered" && typeof by === "string") {
    return { type: "covered", by };
  }
  const reason = mcp["reason"];
  if (type === "internal" && typeof reason === "string") {
    return { type: "internal", reason };
  }
  return { type: "invalid", raw: mcp };
};

/**
 * Enumerate every `{ config, handler }` export a module exposes as an endpoint,
 * deduplicated by object identity. The default export takes the plain module id;
 * a named export takes `id#exportName`. An object exported as both default and a
 * name is recorded once under the default id, so existing baseline entries stay
 * valid. Pure (a plain record in, no I/O) so the self-test can exercise it.
 */
export const enumerateModuleEndpoints = (
  mod: Record<string, unknown>,
  moduleId: string,
): { id: string; exposure: ParsedExposure }[] => {
  const endpoints: { id: string; exposure: ParsedExposure }[] = [];
  const claimed = new Set<object>();

  const defaultExport = mod["default"];
  if (isEndpointModule(defaultExport)) {
    claimed.add(defaultExport);
    endpoints.push({
      id: moduleId,
      exposure: parseExposure(defaultExport.config["mcp"]),
    });
  }

  for (const [key, value] of Object.entries(mod)) {
    if (key === "default" || !isEndpointModule(value) || claimed.has(value)) {
      continue;
    }
    claimed.add(value);
    endpoints.push({
      id: `${moduleId}#${key}`,
      exposure: parseExposure(value.config["mcp"]),
    });
  }

  return endpoints;
};

export type CoverageIssues = {
  missingMcp: string[];
  invalidExposure: string[];
  unknownToolNames: { id: string; name: string }[];
  orphanTools: string[];
  staleWaivers: string[];
};

type ClassifyInput = {
  endpoints: readonly { id: string; exposure: ParsedExposure }[];
  registryToolNames: readonly string[];
  waivers: Record<string, string>;
};

/**
 * Pure coverage classification: given the parsed endpoints, the registry tool
 * names, and the inline/static waiver map, compute every category of failure.
 * Kept pure (no I/O) so the test suite can exercise the logic directly.
 */
export const classifyCoverage = ({
  endpoints,
  registryToolNames,
  waivers,
}: ClassifyInput): CoverageIssues => {
  const registry = new Set(registryToolNames);
  const missingMcp: string[] = [];
  const invalidExposure: string[] = [];
  const unknownToolNames: { id: string; name: string }[] = [];
  const referencedTools = new Set<string>();

  for (const { id, exposure } of endpoints) {
    if (exposure.type === "invalid") {
      if (exposure.raw === undefined) {
        missingMcp.push(id);
      } else {
        invalidExposure.push(id);
      }
      continue;
    }
    if (exposure.type === "tool") {
      referencedTools.add(exposure.name);
      if (!registry.has(exposure.name)) {
        unknownToolNames.push({ id, name: exposure.name });
      }
    } else if (exposure.type === "covered") {
      referencedTools.add(exposure.by);
      if (!registry.has(exposure.by)) {
        unknownToolNames.push({ id, name: exposure.by });
      }
    }
  }

  const orphanTools: string[] = [];
  for (const tool of registryToolNames) {
    if (referencedTools.has(tool) || tool in waivers) {
      continue;
    }
    orphanTools.push(tool);
  }

  // A waiver naming a tool that no longer exists in the registry is stale and
  // must be removed, so the waiver map only ever documents real backings.
  const staleWaivers = Object.keys(waivers)
    .filter((tool) => !registry.has(tool))
    .sort();

  return {
    missingMcp: missingMcp.sort(),
    invalidExposure: invalidExposure.sort(),
    unknownToolNames: unknownToolNames.sort((a, b) => a.id.localeCompare(b.id)),
    orphanTools: orphanTools.sort(),
    staleWaivers,
  };
};

export type BaselineDiff = {
  newPending: string[];
  stalePending: string[];
};

/**
 * Ratchet diff: `newPending` are `pending` endpoints missing from the baseline
 * (adding a new gap — fails); `stalePending` are baseline entries that are no
 * longer `pending` or no longer exist (the gap closed — the entry must be
 * removed so the baseline can only shrink). The checked-in baseline is empty,
 * which turns this into a zero-pending gate while keeping useful diagnostics if
 * an old or malformed endpoint config still says `pending`.
 */
export const computeBaselineDiff = ({
  currentPending,
  baseline,
}: {
  currentPending: readonly string[];
  baseline: readonly string[];
}): BaselineDiff => {
  const currentSet = new Set(currentPending);
  const baselineSet = new Set(baseline);
  const newPending = currentPending.filter((id) => !baselineSet.has(id)).sort();
  const stalePending = baseline.filter((id) => !currentSet.has(id)).sort();
  return { newPending, stalePending };
};

export type FileEndpointCount = {
  id: string;
  callCount: number;
  enumerableCount: number;
};

export type HiddenEndpointMismatch = FileEndpointCount & { allowed: number };

/**
 * Hidden-endpoint invariant: per file, the factory call-site count must equal
 * the enumerable `{ config, handler }` endpoints plus the allowlisted inline
 * count (0 when not allowlisted). A mismatch means a factory call carries an
 * `mcp` disposition the ratchet cannot see — the endpoint must be exported as a
 * `{ config, handler }` object, or the file allowlisted with its exact inline
 * count. Pure so the self-test can exercise it.
 */
export const findHiddenEndpointMismatches = ({
  files,
  allowlist,
}: {
  files: readonly FileEndpointCount[];
  allowlist: Record<string, number>;
}): HiddenEndpointMismatch[] => {
  const mismatches: HiddenEndpointMismatch[] = [];
  for (const { id, callCount, enumerableCount } of files) {
    const allowed = allowlist[id] ?? 0;
    if (callCount !== enumerableCount + allowed) {
      mismatches.push({ id, callCount, enumerableCount, allowed });
    }
  }
  return mismatches.sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * A stale allowlist entry is a fail-open hole, not just clutter: once a file's
 * inline endpoints are migrated out (or the file is deleted), discovery skips
 * it entirely (0 factory call sites), so the mismatch check never runs there —
 * and the lingering entry would silently admit that many brand-new inline
 * endpoints later. Pure so the self-test can exercise it.
 */
export const findStaleAllowlistEntries = ({
  files,
  allowlist,
}: {
  files: readonly FileEndpointCount[];
  allowlist: Record<string, number>;
}): string[] => {
  const discovered = new Set(files.map(({ id }) => id));
  return Object.keys(allowlist)
    .filter((id) => !discovered.has(id))
    .sort((a, b) => a.localeCompare(b));
};

const readBaseline = async (): Promise<string[]> => {
  const file = Bun.file(BASELINE_PATH);
  if (!(await file.exists())) {
    return [];
  }
  const parsed: unknown = await file.json();
  if (!Array.isArray(parsed)) {
    return panic(
      `mcp-coverage-guard: ${BASELINE_PATH} must be a JSON array of strings.`,
    );
  }
  const entries: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      return panic(
        `mcp-coverage-guard: ${BASELINE_PATH} must be a JSON array of strings.`,
      );
    }
    entries.push(item);
  }
  return entries;
};

const writeBaseline = async (pending: readonly string[]): Promise<void> => {
  const sorted = [...pending].sort();
  await Bun.write(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
};

type Discovered = {
  endpoints: { id: string; exposure: ParsedExposure }[];
  importErrors: { id: string; message: string }[];
  files: FileEndpointCount[];
};

const discoverEndpoints = async (): Promise<Discovered> => {
  // Seed env defaults so handler modules import without real services (same
  // approach as exact-mirror-guard).
  await import("../src/tests/setup-env");
  const { Glob } = await import("bun");
  const glob = new Glob(HANDLERS_GLOB);

  const endpoints: { id: string; exposure: ParsedExposure }[] = [];
  const importErrors: { id: string; message: string }[] = [];
  const files: FileEndpointCount[] = [];

  for await (const rel of glob.scan({ cwd: REPO_ROOT, absolute: true })) {
    if (rel.endsWith(".test.ts")) {
      continue;
    }
    const source = await Bun.file(rel).text();
    const callCount = (source.match(SAFE_HANDLER_CALL_PATTERN) ?? []).length;
    if (callCount === 0) {
      continue;
    }
    const id = toEndpointIdentifier(rel, REPO_ROOT);
    let mod: unknown;
    try {
      mod = await import(rel);
    } catch (error) {
      importErrors.push({
        id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!isRecord(mod)) {
      continue;
    }
    const moduleEndpoints = enumerateModuleEndpoints(mod, id);
    endpoints.push(...moduleEndpoints);
    files.push({ id, callCount, enumerableCount: moduleEndpoints.length });
  }

  endpoints.sort((a, b) => a.id.localeCompare(b.id));
  files.sort((a, b) => a.id.localeCompare(b.id));
  return { endpoints, importErrors, files };
};

const printIssues = (issues: CoverageIssues): boolean => {
  let failed = false;
  if (issues.missingMcp.length > 0) {
    failed = true;
    console.error(
      "\nmcp-coverage-guard: these endpoint configs have no `mcp` disposition:",
    );
    for (const id of issues.missingMcp) {
      console.error(`  ${id}`);
    }
  }
  if (issues.invalidExposure.length > 0) {
    failed = true;
    console.error(
      "\nmcp-coverage-guard: these endpoint configs have a malformed `mcp` value:",
    );
    for (const id of issues.invalidExposure) {
      console.error(`  ${id}`);
    }
  }
  if (issues.unknownToolNames.length > 0) {
    failed = true;
    console.error(
      "\nmcp-coverage-guard: these tool/covered references name a tool that is not in the static registry:",
    );
    for (const { id, name } of issues.unknownToolNames) {
      console.error(`  ${id} -> ${name}`);
    }
  }
  if (issues.orphanTools.length > 0) {
    failed = true;
    console.error(
      '\nmcp-coverage-guard: these registry tools are orphaned (no `type: "tool"`/`covered` endpoint references them, and no TOOLS_WITHOUT_ENUMERABLE_ENDPOINT waiver):',
    );
    for (const tool of issues.orphanTools) {
      console.error(`  ${tool}`);
    }
  }
  if (issues.staleWaivers.length > 0) {
    failed = true;
    console.error(
      "\nmcp-coverage-guard: these TOOLS_WITHOUT_ENUMERABLE_ENDPOINT waivers name a tool that no longer exists — remove them:",
    );
    for (const tool of issues.staleWaivers) {
      console.error(`  ${tool}`);
    }
  }
  return failed;
};

const runCheck = async (): Promise<number> => {
  const { endpoints, importErrors, files } = await discoverEndpoints();

  if (importErrors.length > 0) {
    console.error(
      "\nmcp-coverage-guard: could not import these handler modules, so their `mcp` disposition could not be verified:",
    );
    for (const { id, message } of importErrors) {
      console.error(`  ${id}: ${message}`);
    }
    return 1;
  }

  const hiddenEndpoints = findHiddenEndpointMismatches({
    files,
    allowlist: INLINE_ENDPOINT_ALLOWLIST,
  });
  let hiddenEndpointFailed = false;
  if (hiddenEndpoints.length > 0) {
    hiddenEndpointFailed = true;
    console.error(
      "\nmcp-coverage-guard: these files have `createSafe*Handler` call sites that the guard cannot enumerate into the ratchet. Export each endpoint as a `{ config, handler }` object, or allowlist the file in INLINE_ENDPOINT_ALLOWLIST with its exact inline count:",
    );
    for (const { id, callCount, enumerableCount, allowed } of hiddenEndpoints) {
      const enumerable =
        allowed > 0
          ? `${enumerableCount} enumerable endpoint configs + ${allowed} allowlisted inline`
          : `${enumerableCount} enumerable endpoint configs`;
      console.error(
        `  ${id}: ${callCount} createSafe*Handler calls but ${enumerable}`,
      );
    }
  }

  const staleAllowlistEntries = findStaleAllowlistEntries({
    files,
    allowlist: INLINE_ENDPOINT_ALLOWLIST,
  });
  if (staleAllowlistEntries.length > 0) {
    hiddenEndpointFailed = true;
    console.error(
      "\nmcp-coverage-guard: these INLINE_ENDPOINT_ALLOWLIST entries no longer match a file with `createSafe*Handler` call sites (renamed, deleted, or fully migrated to endpoint modules). Remove them so they cannot admit future inline endpoints:",
    );
    for (const id of staleAllowlistEntries) {
      console.error(`  ${id}`);
    }
  }

  if (endpoints.length === 0) {
    console.error(
      "\nmcp-coverage-guard: discovered 0 endpoint modules — the guard did not exercise anything. Fix module discovery before trusting a green run.",
    );
    return 1;
  }

  const { MCP_STATIC_TOOL_NAMES } =
    await import("../src/mcp/static-tool-definitions");

  const issues = classifyCoverage({
    endpoints,
    registryToolNames: MCP_STATIC_TOOL_NAMES,
    waivers: TOOLS_WITHOUT_ENUMERABLE_ENDPOINT,
  });
  const coverageFailed = printIssues(issues);

  const currentPending = endpoints
    .filter(({ exposure }) => exposure.type === "pending")
    .map(({ id }) => id);

  const baseline = await readBaseline();
  const { newPending, stalePending } = computeBaselineDiff({
    currentPending,
    baseline,
  });

  let ratchetFailed = false;
  if (newPending.length > 0) {
    ratchetFailed = true;
    console.error(
      "\nmcp-coverage-guard: these endpoints are `pending` but not in the baseline. The pending baseline can only shrink: give them a real `mcp` disposition (`tool`/`covered`/`internal`), do not add new pending gaps:",
    );
    for (const id of newPending) {
      console.error(`  ${id}`);
    }
  }
  if (stalePending.length > 0) {
    ratchetFailed = true;
    console.error(
      "\nmcp-coverage-guard: these baseline entries are no longer `pending` (or no longer exist). Remove them from apps/api/mcp-coverage-baseline.json to keep the ratchet tight:",
    );
    for (const id of stalePending) {
      console.error(`  ${id}`);
    }
  }

  if (coverageFailed || ratchetFailed || hiddenEndpointFailed) {
    return 1;
  }

  console.log(
    `mcp-coverage-guard: OK. ${endpoints.length} endpoint modules enumerated; ${currentPending.length} pending (baselined); ${MCP_STATIC_TOOL_NAMES.length} static tools, no orphans.`,
  );
  return 0;
};

const runWriteBaseline = async (): Promise<number> => {
  const { endpoints, importErrors } = await discoverEndpoints();
  if (importErrors.length > 0) {
    console.error(
      "mcp-coverage-guard --write-baseline: refusing to write; some modules failed to import:",
    );
    for (const { id, message } of importErrors) {
      console.error(`  ${id}: ${message}`);
    }
    return 1;
  }
  const pending = endpoints
    .filter(({ exposure }) => exposure.type === "pending")
    .map(({ id }) => id);
  await writeBaseline(pending);
  console.log(
    `mcp-coverage-guard --write-baseline: wrote ${pending.length} pending endpoints to apps/api/mcp-coverage-baseline.json`,
  );
  return 0;
};

// Self-test: prove the ratchet detectors fire on synthetic inputs, through the
// same pure functions the real check uses. A broken detector cannot pass here.
const runSelfTest = (): number => {
  const failures: string[] = [];

  const newGap = computeBaselineDiff({
    currentPending: ["a", "b"],
    baseline: ["a"],
  });
  if (newGap.newPending.length !== 1 || newGap.newPending[0] !== "b") {
    failures.push("computeBaselineDiff did not flag a new pending endpoint");
  }

  const stale = computeBaselineDiff({
    currentPending: ["a"],
    baseline: ["a", "gone"],
  });
  if (stale.stalePending.length !== 1 || stale.stalePending[0] !== "gone") {
    failures.push("computeBaselineDiff did not flag a stale baseline entry");
  }

  const orphan = classifyCoverage({
    endpoints: [{ id: "x.ts", exposure: { type: "pending" } }],
    registryToolNames: ["only_tool"],
    waivers: {},
  });
  if (!orphan.orphanTools.includes("only_tool")) {
    failures.push("classifyCoverage did not flag an orphan tool");
  }

  const badName = classifyCoverage({
    endpoints: [{ id: "x.ts", exposure: { type: "tool", name: "ghost" } }],
    registryToolNames: ["real"],
    waivers: { real: "waived" },
  });
  if (badName.unknownToolNames.length !== 1) {
    failures.push("classifyCoverage did not flag an unknown tool name");
  }

  const missing = classifyCoverage({
    endpoints: [{ id: "x.ts", exposure: { type: "invalid", raw: undefined } }],
    registryToolNames: [],
    waivers: {},
  });
  if (!missing.missingMcp.includes("x.ts")) {
    failures.push("classifyCoverage did not flag a missing mcp disposition");
  }

  const sharedEndpoint = {
    config: { mcp: { type: "internal", reason: "webhook" } },
    handler: () => null,
  };
  const namedEndpoint = {
    config: { mcp: { type: "pending" } },
    handler: () => null,
  };
  const enumerated = enumerateModuleEndpoints(
    {
      default: sharedEndpoint,
      primary: sharedEndpoint,
      extra: namedEndpoint,
      schema: { not: "an endpoint" },
    },
    "m.ts",
  );
  const enumeratedIds = enumerated.map(({ id }) => id).sort();
  if (
    enumeratedIds.length !== 2 ||
    enumeratedIds[0] !== "m.ts" ||
    enumeratedIds[1] !== "m.ts#extra"
  ) {
    failures.push(
      "enumerateModuleEndpoints did not discover the named export (or did not dedupe the default)",
    );
  }

  const mismatch = findHiddenEndpointMismatches({
    files: [{ id: "hidden.ts", callCount: 2, enumerableCount: 1 }],
    allowlist: {},
  });
  if (mismatch.length !== 1 || mismatch[0]?.id !== "hidden.ts") {
    failures.push(
      "findHiddenEndpointMismatches did not flag a file with an un-enumerable call site",
    );
  }

  const allowlistedExact = findHiddenEndpointMismatches({
    files: [{ id: "inline.ts", callCount: 5, enumerableCount: 0 }],
    allowlist: { "inline.ts": 5 },
  });
  if (allowlistedExact.length !== 0) {
    failures.push(
      "findHiddenEndpointMismatches flagged an allowlisted file whose inline count matched",
    );
  }

  const allowlistedOverflow = findHiddenEndpointMismatches({
    files: [{ id: "inline.ts", callCount: 6, enumerableCount: 0 }],
    allowlist: { "inline.ts": 5 },
  });
  if (
    allowlistedOverflow.length !== 1 ||
    allowlistedOverflow[0]?.id !== "inline.ts"
  ) {
    failures.push(
      "findHiddenEndpointMismatches did not flag an allowlisted file with one extra inline endpoint",
    );
  }

  const staleEntries = findStaleAllowlistEntries({
    files: [{ id: "live.ts", callCount: 2, enumerableCount: 2 }],
    allowlist: { "live.ts": 0, "gone.ts": 5 },
  });
  if (staleEntries.length !== 1 || staleEntries[0] !== "gone.ts") {
    failures.push(
      "findStaleAllowlistEntries did not flag the allowlist entry with no discovered file",
    );
  }

  if (failures.length > 0) {
    console.error("mcp-coverage-guard --self-test: FAIL");
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    return 1;
  }
  console.log("mcp-coverage-guard --self-test: PASS");
  return 0;
};

const main = async (): Promise<number> => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  if (process.argv.includes("--write-baseline")) {
    return await runWriteBaseline();
  }
  return await runCheck();
};

if (import.meta.main) {
  process.exit(await main());
}

// Exported only for the guard's own test suite.
export { EXPOSURE_TYPES, TOOLS_WITHOUT_ENUMERABLE_ENDPOINT };
export type { ExposureType };
