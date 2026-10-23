import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = readFileSync(
  new URL("staging-post-deploy-checks.sh", import.meta.url),
  "utf-8",
);
const checks = [
  "web-smoke",
  "response-policy",
  "api-smoke",
  "model-turn",
  "corpus-preflight",
  "mcp-smoke",
];
type CheckOptions = {
  failure?: string;
  waived?: boolean;
  script?: string;
  web?: boolean;
};
const run = ({
  failure = "",
  waived = false,
  script = source,
  web = true,
}: CheckOptions = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "staging-scheduler-"));
  try {
    const runner = path.join(dir, "runner.sh");
    const fake = path.join(dir, "check.sh");
    const events = path.join(dir, "events");
    const output = path.join(dir, "output");
    const summary = path.join(dir, "summary");
    writeFileSync(runner, script);
    writeFileSync(output, "");
    writeFileSync(summary, "");
    writeFileSync(
      fake,
      `#!/usr/bin/env bash
set -euo pipefail
echo "start:$1" >> "$EVENTS"
# A bounded barrier proves every independent worker starts before any finishes.
if [[ "$1" != mcp-smoke ]]; then
  ready=false
  for ((i=0; i<200; i++)); do
    if [[ $(rg -c '^start:' "$EVENTS") -ge "$WORKERS" ]]; then ready=true; break; fi
    sleep 0.01
  done
  [[ "$ready" == true ]] || exit 9
fi
echo "log:$1"
echo "summary:$1" >> "$GITHUB_STEP_SUMMARY"
echo "finish:$1" >> "$EVENTS"
[[ "$FAIL_CHECK" != "$1" ]]
`,
    );
    const result = Bun.spawnSync(["bash", runner, fake], {
      env: {
        PATH: process.env["PATH"],
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        RUN_WEB_SMOKE: String(web),
        CORPUS_SEARCH_WAIVED: String(waived),
        FAIL_CHECK: failure,
        EVENTS: events,
        WORKERS: web ? "5" : "4",
      },
    });
    return {
      code: result.exitCode,
      log: result.stdout.toString(),
      stderr: result.stderr.toString(),
      outputs: Object.fromEntries(
        readFileSync(output, "utf-8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      ),
      events: readFileSync(events, "utf-8").trim().split("\n"),
      summary: readFileSync(summary, "utf-8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

type AssertResultOptions = {
  result: ReturnType<typeof run>;
  failure?: string;
  waived?: boolean;
  web?: boolean;
};
const assertResult = ({
  result,
  failure = "",
  waived = false,
  web = true,
}: AssertResultOptions) => {
  const blocking =
    failure !== "" &&
    !["response-policy", "model-turn"].includes(failure) &&
    !(failure === "corpus-preflight" && waived);
  expect(result.code, result.stderr).toBe(blocking ? 1 : 0);
  expect(
    Object.keys(result.outputs),
    "every check publishes an outcome",
  ).toEqual(checks);
  let previous = -1;
  for (const check of checks) {
    const skipped =
      (check === "mcp-smoke" && failure === "corpus-preflight") ||
      (check === "web-smoke" && !web);
    const expectedOutcome = check === failure ? "failure" : "success";
    expect(result.outputs[check], check).toBe(
      skipped ? "skipped" : expectedOutcome,
    );
    expect(result.events.includes(`start:${check}`), check).toBe(!skipped);
    expect(result.events.includes(`finish:${check}`), check).toBe(!skipped);
    const group = result.log.indexOf(`::group::${check} (`);
    expect(group).toBeGreaterThan(previous);
    previous = group;
    if (!skipped) {
      expect(result.log).toContain(`log:${check}`);
      expect(result.summary).toContain(`summary:${check}`);
    }
  }
  expect(result.log.match(/::endgroup::/gu)).toHaveLength(checks.length);
  if (failure === "response-policy" || failure === "model-turn") {
    expect(result.log).toContain("::warning title=");
    expect(result.summary).toContain(
      "FAILED (report-only, promotion not blocked)",
    );
  }
  if (failure !== "corpus-preflight") {
    expect(result.events.indexOf("start:mcp-smoke")).toBeGreaterThan(
      result.events.indexOf("finish:corpus-preflight"),
    );
  }
};

test("all independent checks overlap, logs are ordered and MCP follows preflight", () =>
  assertResult({ result: run() }));
for (const failure of checks) {
  test(`${failure} failure preserves every outcome and finishes the other workers`, () =>
    assertResult({ result: run({ failure }), failure }));
}
test("a named corpus waiver permits failed preflight while MCP stays skipped", () =>
  assertResult({
    result: run({ failure: "corpus-preflight", waived: true }),
    failure: "corpus-preflight",
    waived: true,
  }));
test("the web smoke retains its prior-success condition", () =>
  assertResult({ result: run({ web: false }), web: false }));

test("each production command receives its original inputs and model mode", () => {
  const edge = ["E2E_EDGE_HEADER_NAME", "E2E_EDGE_HEADER_VALUE"];
  const api = [
    "E2E_API_URL",
    "SMOKE_SESSION_SECRET",
    "EXPECTED_COMMIT",
    ...edge,
  ];
  const inputs = {
    "web-smoke": ["STAGING_STATE", "E2E_WEB_URL", ...api],
    "response-policy": ["E2E_WEB_URL", "E2E_API_URL", ...edge],
    "api-smoke": api,
    "model-turn": [...api, "SMOKE_AI_OPENAI_API_KEY"],
    "corpus-preflight": ["E2E_API_URL", ...edge],
    "mcp-smoke": [
      "MCP_CANARY_ENVIRONMENT",
      "MCP_CANARY_BASE_URL",
      "MCP_CANARY_CONFIGURED_BASE_URL",
      "MCP_CANARY_FRONTEND_URL",
      "MCP_CANARY_MODE",
      "MCP_CANARY_REQUIRE_CREDENTIALS",
      "APP_REVIEW_ACCOUNT_EMAIL",
      "APP_REVIEW_ORGANIZATION_ID",
      "REVIEW_ACCOUNT_PASSWORD",
      "SMOKE_SESSION_SECRET",
      ...edge,
    ],
  };
  expect(Object.keys(inputs)).toEqual(checks);
  const keys = [...new Set(Object.values(inputs).flat())];
  const dir = mkdtempSync(path.join(tmpdir(), "staging-command-env-"));
  try {
    const browser = path.join(dir, ".github/actions/setup-playwright");
    mkdirSync(browser, { recursive: true });
    for (const file of [
      path.join(dir, "bun"),
      path.join(dir, "timeout"),
      path.join(browser, "run-in-image.sh"),
    ]) {
      writeFileSync(file, "#!/usr/bin/env bash\n/usr/bin/env\n", {
        mode: 0o755,
      });
    }
    for (const [check, expected] of Object.entries(inputs)) {
      const result = Bun.spawnSync(
        ["bash", path.join(import.meta.dir, "staging-deploy-check.sh"), check],
        {
          env: {
            ...Object.fromEntries(keys.map((key) => [key, `fixture-${key}`])),
            PATH: `${dir}:${process.env["PATH"] ?? ""}`,
            GITHUB_WORKSPACE: dir,
            RUN_WEB_SMOKE: "true",
            CORPUS_SEARCH_WAIVED: "false",
          },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const received = Object.fromEntries(
        result.stdout
          .toString()
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      expect(keys.filter((key) => key in received).toSorted(), check).toEqual(
        expected.toSorted(),
      );
      for (const key of expected) {
        expect(received[key], `${check}: ${key}`).toBe(`fixture-${key}`);
      }
      if (check === "api-smoke" || check === "model-turn") {
        expect(received["SMOKE_AI_JOURNEY"], check).toBe(
          check === "api-smoke" ? "skip" : "only",
        );
      } else {
        expect(received["SMOKE_AI_JOURNEY"], check).toBeUndefined();
      }
      expect(received["RUN_WEB_SMOKE"]).toBeUndefined();
      expect(received["CORPUS_SEARCH_WAIVED"]).toBeUndefined();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocking, report-only, preflight dependency and output mutations are detected", () => {
  const mutations = [
    {
      failure: "api-smoke",
      from: '*)\n      if [[ "$outcome" == failure ]]; then\n        failed=1',
      to: '*)\n      if [[ "$outcome" == failure ]]; then\n        failed=0',
    },
    {
      failure: "model-turn",
      from: 'if [[ "$outcome" == failure ]]; then\n        echo "::warning',
      to: 'if [[ "$outcome" == failure ]]; then\n        failed=1\n        echo "::warning',
    },
    {
      failure: "corpus-preflight",
      from: "if run_check corpus-preflight; then",
      to: "if run_check corpus-preflight || true; then",
    },
    {
      failure: "",
      from: 'echo "$check=$outcome" >> "$GITHUB_OUTPUT"',
      to: ":",
    },
  ];
  for (const { failure, from, to } of mutations) {
    const mutant = source.replace(from, () => to);
    expect(mutant).not.toBe(source);
    expect(() =>
      assertResult({ result: run({ failure, script: mutant }), failure }),
    ).toThrow(/Expected/u);
  }
});
