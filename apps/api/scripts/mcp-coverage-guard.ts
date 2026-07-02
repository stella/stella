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
//   4. a ratcheted baseline of `pending` endpoints that can only shrink: any
//      new `pending` fails, and any baseline entry that is no longer `pending`
//      (or no longer exists) is stale and must be removed.
//
// Enumeration is by module glob + dynamic import of each handler module's
// default `{ config, handler }` export, NOT Elysia route introspection: the
// `mcp` field lives on the endpoint config and is never threaded into the
// route wiring, so the composed app cannot see it. Route wiring itself stays
// typecheck-enforced separately. The trade-off: endpoints defined inline in a
// `routes.ts` (not default-exported) are typecheck-enforced for `mcp` but not
// enumerated here; the few such endpoints that back a tool are pinned in
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
 */
const SAFE_HANDLER_CALL_PATTERN =
  /createSafe(?:Root|Session|Token|Public)?Handler[<(]/u;

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
  get_matter_overview:
    "inline endpoint: apps/api/src/handlers/workspaces/routes.ts GET /:workspaceId/overview",
  search_case_law:
    "inline endpoint: apps/api/src/handlers/case-law/public-routes.ts POST /case/decisions/search",
  read_case_law_decision:
    "inline endpoint: apps/api/src/handlers/case-law/public-routes.ts GET /case/decisions/:decisionId",
  read_content_across_matters:
    "no dedicated endpoint: MCP handler reads extractedContent directly (apps/api/src/mcp/stella-tools.ts)",
  fetch:
    "no dedicated endpoint: compat alias, MCP handler reads extractedContent directly (apps/api/src/mcp/compat-tools.ts)",
  configure_template_fields:
    "no dedicated endpoint: MCP-only, configure-template-fields-service.ts has no HTTP route",
  template_marker_reference:
    "static reference: buildMarkerReference (apps/api/src/mcp/template-marker-reference.ts), no HTTP route",
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

/** Narrow an unknown default export to an endpoint definition shape. */
export const isEndpointModule = (
  value: unknown,
): value is { config: Record<string, unknown>; handler: unknown } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("config" in value) || !("handler" in value)) {
    return false;
  }
  const { config, handler } = value as { config: unknown; handler: unknown };
  return (
    typeof handler === "function" &&
    typeof config === "object" &&
    config !== null
  );
};

/** Parse a config's `mcp` value into a discriminated result the guard checks. */
export const parseExposure = (mcp: unknown): ParsedExposure => {
  if (typeof mcp !== "object" || mcp === null || !("type" in mcp)) {
    return { type: "invalid", raw: mcp };
  }
  const type = (mcp as { type: unknown }).type;
  if (type === "pending") {
    return { type: "pending" };
  }
  if (type === "tool" && typeof (mcp as { name?: unknown }).name === "string") {
    return { type: "tool", name: (mcp as { name: string }).name };
  }
  if (type === "covered" && typeof (mcp as { by?: unknown }).by === "string") {
    return { type: "covered", by: (mcp as { by: string }).by };
  }
  if (
    type === "internal" &&
    typeof (mcp as { reason?: unknown }).reason === "string"
  ) {
    return { type: "internal", reason: (mcp as { reason: string }).reason };
  }
  return { type: "invalid", raw: mcp };
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
 * removed so the baseline can only shrink).
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

const readBaseline = async (): Promise<string[]> => {
  const file = Bun.file(BASELINE_PATH);
  if (!(await file.exists())) {
    return [];
  }
  const parsed: unknown = await file.json();
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    return panic(
      `mcp-coverage-guard: ${BASELINE_PATH} must be a JSON array of strings.`,
    );
  }
  return parsed as string[];
};

const writeBaseline = async (pending: readonly string[]): Promise<void> => {
  const sorted = [...pending].sort();
  await Bun.write(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
};

type Discovered = {
  endpoints: { id: string; exposure: ParsedExposure }[];
  importErrors: { id: string; message: string }[];
};

const discoverEndpoints = async (): Promise<Discovered> => {
  // Seed env defaults so handler modules import without real services (same
  // approach as exact-mirror-guard).
  await import("../src/tests/setup-env");
  const { Glob } = await import("bun");
  const glob = new Glob(HANDLERS_GLOB);

  const endpoints: { id: string; exposure: ParsedExposure }[] = [];
  const importErrors: { id: string; message: string }[] = [];

  for await (const rel of glob.scan({ cwd: REPO_ROOT, absolute: true })) {
    if (rel.endsWith(".test.ts")) {
      continue;
    }
    const source = await Bun.file(rel).text();
    if (!SAFE_HANDLER_CALL_PATTERN.test(source)) {
      continue;
    }
    const id = toEndpointIdentifier(rel, REPO_ROOT);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(rel)) as Record<string, unknown>;
    } catch (error) {
      importErrors.push({
        id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!isEndpointModule(mod.default)) {
      continue;
    }
    endpoints.push({ id, exposure: parseExposure(mod.default.config.mcp) });
  }

  endpoints.sort((a, b) => a.id.localeCompare(b.id));
  return { endpoints, importErrors };
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
  const { endpoints, importErrors } = await discoverEndpoints();

  if (importErrors.length > 0) {
    console.error(
      "\nmcp-coverage-guard: could not import these handler modules, so their `mcp` disposition could not be verified:",
    );
    for (const { id, message } of importErrors) {
      console.error(`  ${id}: ${message}`);
    }
    return 1;
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

  if (coverageFailed || ratchetFailed) {
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
