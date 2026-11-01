import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const workflowFile = Bun.file(
  new URL("../.github/workflows/deploy-staging.yml", import.meta.url),
);
let workspace = "";
let script = "";

const preflightScript = (workflow: string) => {
  const start = workflow.indexOf(
    "      - name: Check staging corpus search backend\n",
  );
  const run = workflow.indexOf("        run: |\n", start);
  const end = workflow.indexOf(
    "      - name: Run staging MCP user journeys\n",
    run,
  );
  if (start === -1 || run === -1 || end === -1) {
    throw new Error("Staging corpus preflight must precede MCP smoke");
  }
  return workflow
    .slice(run + "        run: |\n".length, end)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
};

const assertMcpGate = (workflow: string) => {
  const start = workflow.indexOf(
    "      - name: Run staging MCP user journeys\n",
  );
  const end = workflow.indexOf("        run:", start);
  expect(
    workflow.slice(start, end),
    "MCP smoke requires the corpus preflight",
  ).toContain("steps.corpus-preflight.outcome == 'success'");
  expect(
    workflow.slice(start, end),
    "MCP smoke requires staging readiness",
  ).toContain("steps.proof-readiness.outputs.status == 'ready'");
};

type ProbeName = "search" | "legislation" | "coverage";
type ProbeStub = { status: string; body: string; transportExit?: number };
type PreflightCase = {
  stubs?: Partial<Record<ProbeName, ProbeStub>>;
  source?: string;
  edgeHeader?: string;
};

const readyBody = JSON.stringify({
  hits: [],
  queryUsed: "contract",
  total: { value: 0, relation: "eq" },
});
const readyStubs: Record<ProbeName, ProbeStub> = {
  search: { status: "200", body: readyBody },
  legislation: { status: "200", body: JSON.stringify({ items: [] }) },
  coverage: {
    status: "200",
    body: JSON.stringify({ health: "current", stored: { decisions: 1 } }),
  },
};
const stubEnv = (stubs: Partial<Record<ProbeName, ProbeStub>>) =>
  Object.fromEntries(
    Object.entries({ ...readyStubs, ...stubs }).flatMap(([name, stub]) => [
      [`STUB_${name.toUpperCase()}_STATUS`, stub.status],
      [`STUB_${name.toUpperCase()}_BODY`, stub.body],
      [`STUB_${name.toUpperCase()}_EXIT`, String(stub.transportExit ?? 0)],
    ]),
  );

const runPreflight = async ({
  stubs = {},
  source = script,
  edgeHeader = "",
}: PreflightCase = {}) => {
  const directory = await mkdtemp(path.join(workspace, "case-"));
  const scriptPath = path.join(directory, "preflight.sh");
  const callsPath = path.join(directory, "calls.txt");
  const summaryPath = path.join(directory, "summary.md");
  await Promise.all([
    Bun.write(scriptPath, source),
    Bun.write(callsPath, ""),
    Bun.write(summaryPath, ""),
  ]);
  const result = Bun.spawnSync(["bash", scriptPath], {
    env: {
      ...process.env,
      PATH: `${workspace}:${process.env["PATH"] ?? ""}`,
      RUNNER_TEMP: directory,
      GITHUB_STEP_SUMMARY: summaryPath,
      E2E_API_URL: "https://api-staging.example.test",
      E2E_EDGE_HEADER_NAME: "x-stella-edge-token",
      E2E_EDGE_HEADER_VALUE: edgeHeader,
      STUB_CALLS_PATH: callsPath,
      ...stubEnv(stubs),
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    calls: await Bun.file(callsPath).text(),
    summary: await Bun.file(summaryPath).text(),
  };
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "staging-corpus-preflight-"));
  script = preflightScript(await workflowFile.text());
  const curl = path.join(workspace, "curl");
  await Bun.write(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$STUB_CALLS_PATH"
output=""
url=""
while (( $# > 0 )); do
  if [[ "$1" == "--output" ]]; then
    output="$2"
    shift
  fi
  url="$1"
  shift
done
case "$url" in
  */v1/case/decisions/search) probe=SEARCH ;;
  */v1/law/statutes/search) probe=LEGISLATION ;;
  */v1/case/coverage) probe=COVERAGE ;;
  *) echo "unexpected URL $url" >&2; exit 99 ;;
esac
status_var="STUB_\${probe}_STATUS"
body_var="STUB_\${probe}_BODY"
exit_var="STUB_\${probe}_EXIT"
printf '%s' "\${!body_var}" > "$output"
printf '%s' "\${!status_var}"
exit "\${!exit_var}"
`,
  );
  await chmod(curl, 0o755);
});
afterAll(async () => await rm(workspace, { recursive: true, force: true }));

test("successful empty answers prove every corpus backend without requiring matches", async () => {
  const result = await runPreflight({ edgeHeader: "fixture-token" });
  expect(result.exitCode).toBe(0);
  expect(result.summary).toContain("backend answered");
  const calls = result.calls.trim().split("\n");
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(call).toContain("--connect-timeout 5 --max-time 30");
    expect(call).toContain("--header x-stella-edge-token: fixture-token");
    expect(call).not.toContain("--location");
  }
  expect(calls[0]).toContain(
    '--data {"query":"contract","country":"CZ","limit":1,"strict":true}',
  );
  expect(calls[0]).toContain(
    "https://api-staging.example.test/v1/case/decisions/search",
  );
  expect(calls[1]).toContain("--get");
  expect(calls[1]).toContain(
    "https://api-staging.example.test/v1/law/statutes/search",
  );
  expect(calls[2]).toContain(
    "https://api-staging.example.test/v1/case/coverage",
  );
});

const unavailable: readonly ProbeStub[] = [
  { status: "404", body: '{"message":"Search index not found"}' },
  { status: "503", body: '{"message":"Search is temporarily unavailable"}' },
  { status: "500", body: '{"message":"Internal server error"}' },
  { status: "000", body: "", transportExit: 7 },
  { status: "000", body: "", transportExit: 28 },
  { status: "200", body: "<html>login</html>" },
  { status: "200", body: '{"message":"Coverage is unavailable"}' },
];
const invalid: Record<ProbeName, readonly string[]> = {
  search: [
    '{"hits":[],"queryUsed":"contract"}',
    '{"hits":[],"queryUsed":"","total":0}',
  ],
  legislation: ['{"items":{}}', '{"items":[],"message":"partial"}'],
  coverage: ['{"stored":{"decisions":1}}', '{"health":null}'],
};
const probeLabels: Record<ProbeName, string> = {
  search: "case-law-search",
  legislation: "legislation-search",
  coverage: "case-law-coverage",
};
const failureCases = (Object.keys(probeLabels) as ProbeName[]).flatMap(
  (probe) => [
    ...unavailable.map((stub) => ({ probe, stub })),
    ...invalid[probe].map((body) => ({ probe, stub: { status: "200", body } })),
  ],
);

test.each(failureCases)(
  "an unavailable or invalid $probe answer fails clearly ($stub.status, $stub.body)",
  async ({ probe, stub }) => {
    const result = await runPreflight({ stubs: { [probe]: stub } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("::error title=corpus index down::");
    expect(result.summary).toContain(
      `corpus index down: staging ${probeLabels[probe]} preflight failed (HTTP ${stub.status}).`,
    );
    expect(result.summary).not.toContain("backend answered");
    expect(result.calls).not.toContain("x-stella-edge-token:");
    // Every probe still runs, so one report names every unavailable backend.
    expect(result.calls.trim().split("\n")).toHaveLength(3);
  },
);

test("each unavailable backend is reported once", async () => {
  const down = { status: "503", body: '{"message":"unavailable"}' };
  const result = await runPreflight({
    stubs: { legislation: down, coverage: down },
  });
  expect(result.exitCode).toBe(1);
  const lines = result.summary.trim().split("\n");
  expect(lines).toEqual([
    "corpus index down: staging legislation-search preflight failed (HTTP 503).",
    "corpus index down: staging case-law-coverage preflight failed (HTTP 503).",
  ]);
});

test("the former missing preflight and an ungated MCP smoke violate the contract", async () => {
  const workflow = await workflowFile.text();
  assertMcpGate(workflow);
  const ungated = workflow.replace(
    " && steps.corpus-preflight.outcome == 'success'",
    "",
  );
  expect(ungated).not.toBe(workflow);
  expect(() => assertMcpGate(ungated)).toThrow(
    "MCP smoke requires the corpus preflight",
  );
  const removed = workflow.replace(
    "      - name: Check staging corpus search backend\n",
    "",
  );
  expect(() => preflightScript(removed)).toThrow(
    "Staging corpus preflight must precede MCP smoke",
  );
});

test("accepting a backend failure breaks the executed preflight guard", async () => {
  const input = {
    stubs: {
      coverage: {
        status: "200",
        body: '{"message":"Coverage is unavailable"}',
      },
    },
  };
  const assertFailure = (exitCode: number) =>
    expect(exitCode, "backend failure must stop MCP smoke").toBe(1);
  assertFailure((await runPreflight(input)).exitCode);
  const mutated = script.replace("  exit 1\nfi", "  exit 0\nfi");
  expect(mutated).not.toBe(script);
  const result = await runPreflight({ ...input, source: mutated });
  expect(() => assertFailure(result.exitCode)).toThrow(
    "backend failure must stop MCP smoke",
  );
});
