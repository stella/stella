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
  ).toContain("steps.corpus-preflight.conclusion == 'success'");
};

type PreflightCase = {
  status: string;
  body: string;
  transportExit?: number;
  source?: string;
  edgeHeader?: string;
};
const runPreflight = async ({
  status,
  body,
  transportExit = 0,
  source = script,
  edgeHeader = "",
}: PreflightCase) => {
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
      STUB_STATUS: status,
      STUB_BODY: body,
      STUB_TRANSPORT_EXIT: String(transportExit),
      STUB_CALLS_PATH: callsPath,
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
while (( $# > 0 )); do
  if [[ "$1" == "--output" ]]; then
    output="$2"
    shift
  fi
  shift
done
printf '%s' "$STUB_BODY" > "$output"
printf '%s' "$STUB_STATUS"
exit "$STUB_TRANSPORT_EXIT"
`,
  );
  await chmod(curl, 0o755);
});
afterAll(async () => await rm(workspace, { recursive: true, force: true }));

const readyBody = JSON.stringify({
  hits: [],
  queryUsed: "contract",
  total: { value: 0, relation: "eq" },
});

test("a successful empty search proves the backend without requiring corpus matches", async () => {
  const result = await runPreflight({
    status: "200",
    body: readyBody,
    edgeHeader: "fixture-token",
  });
  expect(result.exitCode).toBe(0);
  expect(result.summary).toContain("backend answered");
  expect(result.calls).toContain("--connect-timeout 5 --max-time 30");
  expect(result.calls).toContain(
    '--data {"query":"contract","country":"CZ","limit":1,"strict":true}',
  );
  expect(result.calls).toContain("--header x-stella-edge-token: fixture-token");
  expect(result.calls).toContain(
    "https://api-staging.example.test/v1/case/decisions/search",
  );
  expect(result.calls.trim().split("\n")).toHaveLength(1);
  expect(result.calls).not.toContain("--location");
});

test.each([
  { status: "404", body: '{"message":"Search index not found"}' },
  { status: "503", body: '{"message":"Search is temporarily unavailable"}' },
  { status: "500", body: '{"message":"Internal server error"}' },
  { status: "000", body: "", transportExit: 7 },
  { status: "000", body: "", transportExit: 28 },
  { status: "200", body: "<html>login</html>" },
  { status: "200", body: '{"message":"Search is temporarily unavailable"}' },
  { status: "200", body: '{"hits":[],"queryUsed":"contract"}' },
  { status: "200", body: '{"hits":[],"queryUsed":"","total":0}' },
])(
  "an unavailable or invalid search fails clearly ($status, $body)",
  async (input) => {
    const result = await runPreflight(input);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("::error title=corpus index down::");
    expect(result.summary).toContain("corpus index down");
    expect(result.summary).toContain(`HTTP ${input.status}`);
    expect(result.calls).not.toContain("x-stella-edge-token:");
  },
);

test("the former missing preflight and an ungated MCP smoke violate the contract", async () => {
  const workflow = await workflowFile.text();
  assertMcpGate(workflow);
  const ungated = workflow.replace(
    " && steps.corpus-preflight.conclusion == 'success'",
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
    status: "503",
    body: '{"message":"Search is temporarily unavailable"}',
  };
  const assertFailure = (exitCode: number) =>
    expect(exitCode, "backend failure must stop MCP smoke").toBe(1);
  assertFailure((await runPreflight(input)).exitCode);
  const mutated = script.replace("exit 1", "exit 0");
  expect(mutated).not.toBe(script);
  const result = await runPreflight({ ...input, source: mutated });
  expect(() => assertFailure(result.exitCode)).toThrow(
    "backend failure must stop MCP smoke",
  );
});
