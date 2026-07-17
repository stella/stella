import { describe, expect, test } from "bun:test";
import path from "node:path";

// Repo root, four levels up from this file (packages/property-testing/src).
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * Guard: every environment variable a test suite reads to decide whether to
 * run (a "CI gate") must be set by at least one GitHub Actions workflow.
 *
 * Env-gated suites (`describe.skipIf(process.env["X"] !== "1")`, or an
 * `if (...) describe.skip else describe`) look like coverage but execute
 * nowhere unless a workflow exports the gate variable. When no workflow does,
 * the suite is permanently skipped while still counting as a passing test: an
 * upstream-API drift canary or a Postgres integration suite that never runs.
 * This guard fails the moment a gate has no workflow that turns it on.
 *
 * Gates are discovered by pattern, not a hardcoded list: any test file that
 * compares an UPPER_SNAKE_CASE `process.env[...]` entry against a string
 * literal (`=== "true"`, `!== "1"`) declares a gate. New gates of the same
 * shape are picked up automatically. Always-present config such as
 * `DATABASE_URL` is not matched, because tests read it without a literal
 * comparison.
 *
 * Extension point: a gate intentionally exercised only in local runs (never
 * in CI) belongs in LOCAL_ONLY_GATES with a comment explaining why. That
 * documents the exemption instead of silently weakening the pattern.
 */
const LOCAL_ONLY_GATES = new Set<string>();

const TEST_FILE_GLOB = "{apps,packages}/**/*.test.{ts,tsx}";
const WORKFLOW_GLOB = ".github/workflows/*.{yml,yaml}";

// process.env["NAME"] === "literal"  |  process.env["NAME"] !== "literal"
const GATE_PATTERN =
  /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]\s*(?:===|!==)\s*["'][^"']*["']/gu;

// This guard's own source names the gate variables in prose; skip it so it
// does not report itself as a gate declaration.
const SELF_PATH = "packages/property-testing/src/ci-gate-coverage.test.ts";

const collectGates = async (): Promise<Map<string, string>> => {
  const glob = new Bun.Glob(TEST_FILE_GLOB);
  // Gate name -> first test file that declared it (for a readable failure).
  const gates = new Map<string, string>();
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    if (relativePath.includes("node_modules") || relativePath === SELF_PATH) {
      continue;
    }
    const source = await Bun.file(path.resolve(REPO_ROOT, relativePath)).text();
    for (const match of source.matchAll(GATE_PATTERN)) {
      const gate = match[1];
      if (gate && !LOCAL_ONLY_GATES.has(gate) && !gates.has(gate)) {
        gates.set(gate, relativePath);
      }
    }
  }
  return gates;
};

const readWorkflowText = async (): Promise<string> => {
  const glob = new Bun.Glob(WORKFLOW_GLOB);
  const chunks: string[] = [];
  // `dot: true` so the scan descends into the hidden `.github` directory.
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT, dot: true })) {
    chunks.push(await Bun.file(path.resolve(REPO_ROOT, relativePath)).text());
  }
  return chunks.join("\n");
};

describe("ci-gate coverage convention", () => {
  test("every env-gated test suite has a workflow that sets its gate", async () => {
    const [gates, workflowText] = await Promise.all([
      collectGates(),
      readWorkflowText(),
    ]);

    // Sanity: the known gates must still be discovered by the pattern.
    // A miss here means the detection rotted, not that coverage is fine.
    const discovered = [...gates.keys()].sort();
    expect(discovered).toEqual(
      expect.arrayContaining(["SMOKE_TEST", "STELLA_RUN_POSTGRES_TESTS"]),
    );

    const uncovered = [...gates.entries()]
      .filter(([gate]) => !workflowText.includes(gate))
      .map(([gate, file]) => `${gate} (declared in ${file})`)
      .sort();
    expect(uncovered).toEqual([]);
  });
});
