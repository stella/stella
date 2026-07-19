import { describe, expect, test } from "bun:test";
import path from "node:path";

// Repo root, four levels up from this file (packages/property-testing/src).
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * Guard: every environment variable a test suite reads to decide whether to
 * run (a "CI gate") must be turned on by a workflow that also runs that
 * suite's test file.
 *
 * Env-gated suites (`describe.skipIf(process.env["X"] !== "1")`, or an
 * `if (...) describe.skip else describe`) look like coverage but execute
 * nowhere unless a workflow sets the gate variable and invokes the file.
 * When neither happens, the suite is permanently skipped while still
 * counting as a passing test: an upstream-API drift canary or a Postgres
 * integration suite that never runs. This guard fails the moment a gated
 * file has no workflow that both sets its gate and runs it.
 *
 * Coverage is tracked per (gate, file), not per gate name alone: unrelated
 * suites elsewhere in the repo can reuse the same gate name (SMOKE_TEST also
 * gates the business-registries live-API suites) while never being invoked
 * by any job. Matching only the gate name would treat those as covered
 * because a workflow happens to mention the same string for a different
 * file.
 *
 * Gates are discovered by pattern, not a hardcoded list: any test file that
 * compares an UPPER_SNAKE_CASE `process.env` entry (dot or bracket access)
 * against a string literal (`=== "true"`, `!== "1"`, or their loose-equality
 * forms) declares a gate. New gates of the same shape are picked up
 * automatically. Always-present config such as `DATABASE_URL` is not
 * matched, because tests read it without a literal comparison.
 *
 * Extension points:
 * - LOCAL_ONLY_GATES: a gate intentionally exercised only in local runs
 *   (never in CI). Documents the exemption instead of silently weakening
 *   the pattern.
 * - UNWIRED_TEST_FILES: a gated file that is not yet wired into any
 *   workflow by design (e.g. a live third-party API smoke suite that is a
 *   separate follow-up decision from the suite this change wires up).
 */
const LOCAL_ONLY_GATES = new Set<string>();

// Live-API SMOKE_TEST suites not wired into a workflow by this change. Each
// hits a real upstream endpoint (court register, company registry); wiring
// them into nightly CI is a separate decision from the CJEU drift canary
// this change adds. Remove an entry here once its workflow job exists.
const UNWIRED_TEST_FILES = new Set<string>([
  "apps/api/src/handlers/case-law/ingestion/adapters/at-courts.test.ts",
  "packages/business-registries/src/ares/client.test.ts",
  "packages/business-registries/src/brreg/client.test.ts",
  "packages/business-registries/src/brreg/roles.test.ts",
  "packages/business-registries/src/companies-house/client.test.ts",
  "packages/business-registries/src/denue/client.test.ts",
  "packages/business-registries/src/edgar/client.test.ts",
  "packages/business-registries/src/gcis/client.test.ts",
  "packages/business-registries/src/krs/client.test.ts",
  "packages/business-registries/src/orsr/client.test.ts",
  "packages/business-registries/src/prh/client.test.ts",
  "packages/business-registries/src/recherche-entreprises/client.test.ts",
  "packages/business-registries/src/vies/client.test.ts",
]);

const TEST_FILE_GLOB = "{apps,packages}/**/*.test.{ts,tsx}";
const WORKFLOW_GLOB = ".github/workflows/*.{yml,yaml}";

// process.env.NAME or process.env["NAME"], compared with ===, !==, ==, or !=
// against a string literal.
const GATE_PATTERN =
  /process\.env(?:\s*\.\s*([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])\s*(?:===|!==|==|!=)\s*["'][^"']*["']/gu;

// This guard's own source names the gate variables in prose; skip it so it
// does not report itself as a gate declaration.
const SELF_PATH = "packages/property-testing/src/ci-gate-coverage.test.ts";

type GateDeclaration = { gate: string; file: string };

const collectGates = async (): Promise<GateDeclaration[]> => {
  const glob = new Bun.Glob(TEST_FILE_GLOB);
  const declarations: GateDeclaration[] = [];
  const seen = new Set<string>();
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    if (relativePath.includes("node_modules") || relativePath === SELF_PATH) {
      continue;
    }
    const source = await Bun.file(path.resolve(REPO_ROOT, relativePath)).text();
    for (const match of source.matchAll(GATE_PATTERN)) {
      const gate = match[1] || match[2];
      const key = `${gate} ${relativePath}`;
      if (!gate || LOCAL_ONLY_GATES.has(gate) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      declarations.push({ gate, file: relativePath });
    }
  }
  return declarations;
};

type Workflow = { path: string; text: string };

const readWorkflows = async (): Promise<Workflow[]> => {
  const glob = new Bun.Glob(WORKFLOW_GLOB);
  const workflows: Workflow[] = [];
  // `dot: true` so the scan descends into the hidden `.github` directory.
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT, dot: true })) {
    workflows.push({
      path: relativePath,
      text: await Bun.file(path.resolve(REPO_ROOT, relativePath)).text(),
    });
  }
  return workflows;
};

// Suffixes of a repo-relative path, longest first, dropping at least one
// leading segment each step and stopping before the bare filename. Workflow
// steps run tests from a `working-directory` (e.g. `apps/api`), so the
// command text only ever contains a path relative to that directory, never
// the full repo-relative path. Requiring >= 2 segments avoids treating a
// coincidental filename mention (e.g. in a comment) as evidence the file
// actually runs.
const pathSuffixes = (file: string): string[] => {
  const segments = file.split("/");
  const suffixes: string[] = [];
  for (let dropped = 0; dropped < segments.length - 1; dropped++) {
    suffixes.push(segments.slice(dropped).join("/"));
  }
  return suffixes;
};

// A declaration is wired when some single workflow both sets the gate and
// runs the declaring file. Checking the gate name against the whole
// workflow corpus alone is not enough: see the UNWIRED_TEST_FILES doc above
// for why that produces false coverage.
const isWired = (
  declaration: GateDeclaration,
  workflows: Workflow[],
): boolean => {
  const suffixes = pathSuffixes(declaration.file);
  return workflows.some(
    (workflow) =>
      workflow.text.includes(declaration.gate) &&
      suffixes.some((suffix) => workflow.text.includes(suffix)),
  );
};

describe("ci-gate coverage convention", () => {
  test("every env-gated test suite has a workflow that runs it with its gate set", async () => {
    const [declarations, workflows] = await Promise.all([
      collectGates(),
      readWorkflows(),
    ]);

    // Sanity: the known gates must still be discovered by the pattern.
    // A miss here means the detection rotted, not that coverage is fine.
    const discoveredGates = [
      ...new Set(declarations.map((d) => d.gate)),
    ].sort();
    expect(discoveredGates).toEqual(
      expect.arrayContaining(["SMOKE_TEST", "STELLA_RUN_POSTGRES_TESTS"]),
    );

    const uncovered = declarations
      .filter(
        (declaration) =>
          !UNWIRED_TEST_FILES.has(declaration.file) &&
          !isWired(declaration, workflows),
      )
      .map(({ gate, file }) => `${gate} (declared in ${file})`)
      .sort();
    expect(uncovered).toEqual([]);
  });
});
