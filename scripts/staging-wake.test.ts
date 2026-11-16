import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Runs scripts/staging-wake.sh against a fake gh-retry.sh that answers from a
// fixture map and logs every request, and a fake curl for /ready.

const SCRIPT = path.resolve(import.meta.dirname, "staging-wake.sh");
const WORKFLOW = path.resolve(
  import.meta.dirname,
  "../.github/workflows/deploy-staging.yml",
);
const DEPLOY_SHA = "e".repeat(40);
const INFRA_REPO = "example/infra";
const RUNS_ENDPOINT = `GET /repos/${INFRA_REPO}/actions/workflows/staging-power.yml/runs`;
const DISPATCH_ENDPOINT = `POST /repos/${INFRA_REPO}/actions/workflows/staging-power.yml/dispatches`;
const RUN_ENDPOINT = `GET /repos/${INFRA_REPO}/actions/runs/77`;
const OWNERSHIP_ENDPOINTS = [
  "GET repos/stella/stella/actions/workflows/deploy-staging.yml/runs",
  `GET repos/stella/stella/commits/${DEPLOY_SHA}/statuses`,
];
const STATUS_ENDPOINT = `POST repos/stella/stella/statuses/${DEPLOY_SHA}`;
// Created after any dispatch the test makes; the stale run long before it.
const AFTER_DISPATCH = "2999-01-01T00:00:00Z";
const BEFORE_DISPATCH = "2000-01-01T00:00:00Z";

// Answers `<METHOD> <endpoint without query>` with the next response of its
// list (the last one repeats). Anything else is an unexpected request.
const FAKE_GH_RETRY = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || { echo "unexpected command $1" >&2; exit 98; }
shift
method=GET endpoint="" jq_expr="" input=false fields=()
while (($#)); do
  case "$1" in
    --method) method="$2"; shift 2 ;;
    --jq) jq_expr="$2"; shift 2 ;;
    --input) input=true; shift 2 ;;
    -f) fields+=("$2"); shift 2 ;;
    *) endpoint="$1"; shift ;;
  esac
done
body=""
[[ "$input" != true ]] || body="$(cat)"
key="$method \${endpoint%%\\?*}"
counter="$FAKE_ROOT/count-$(printf '%s' "$key" | tr -c 'a-zA-Z0-9' '_')"
count=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$counter"
jq -cn --arg key "$key" --arg token "$GH_TOKEN" --arg body "$body" \\
  --args '{key: $key, token: $token, fields: $ARGS.positional, body: $body}' \\
  \${fields[@]+"\${fields[@]}"} >> "$FAKE_ROOT/log"
response="$(jq -c --arg key "$key" --argjson n "$count" \\
  'if has($key) then .[$key] | (.[$n - 1] // .[-1]) else null end' "$FAKE_ROOT/fixture.json")"
if [[ "$response" == null ]]; then
  echo "unexpected request: $key" >&2
  exit 99
fi
exit_code="$(jq -r '.exit // 0' <<<"$response")"
payload="$(jq -c '.body // {}' <<<"$response")"
if [[ "$exit_code" != 0 ]]; then
  echo "HTTP 502" >&2
  exit "$exit_code"
fi
if [[ -n "$jq_expr" ]]; then
  jq -r "$jq_expr" <<<"$payload"
else
  printf '%s\\n' "$payload"
fi
`;

// Ready from probe FAKE_READY_AFTER on; "never" stays 503.
const FAKE_CURL = `#!/usr/bin/env bash
set -euo pipefail
output=""
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
count=$(( $(cat "$FAKE_ROOT/probes" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$FAKE_ROOT/probes"
if [[ "$FAKE_READY_AFTER" != never ]] && ((count >= FAKE_READY_AFTER)); then
  printf '{"status":"ok"}' > "$output"
  printf 200
else
  printf '{"status":"not_ready"}' > "$output"
  printf 503
fi
`;

const FAKE_SLEEP = '#!/usr/bin/env bash\necho "$1" >> "$FAKE_ROOT/sleeps"\n';

type Response = { body?: unknown; exit?: number };
type Fixture = Record<string, readonly Response[]>;

const run = (status: string, conclusion: string | null): Response => ({
  body: { status, conclusion },
});

const powerRun = (id: number, createdAt: string, title: string) => ({
  id,
  created_at: createdAt,
  display_title: title,
});

const RUNS_AFTER_DISPATCH: Response = {
  body: {
    workflow_runs: [
      powerRun(77, AFTER_DISPATCH, "Staging power on (2h)"),
      powerRun(70, BEFORE_DISPATCH, "Staging power on (2h)"),
      powerRun(78, AFTER_DISPATCH, "Staging power status"),
      powerRun(79, AFTER_DISPATCH, "Staging power reconcile"),
    ],
  },
};

const baseFixture = (overrides: Fixture = {}): Fixture => ({
  [DISPATCH_ENDPOINT]: [{}],
  [RUNS_ENDPOINT]: [{ body: { workflow_runs: [] } }, RUNS_AFTER_DISPATCH],
  [RUN_ENDPOINT]: [run("queued", null), run("completed", "success")],
  [STATUS_ENDPOINT]: [{}],
  "GET repos/stella/stella/actions/workflows/deploy-staging.yml/runs": [
    {
      body: {
        workflow_runs: [
          {
            id: 9,
            head_branch: "main",
            path: ".github/workflows/deploy-staging.yml",
            display_title: `Deploy main to staging ${DEPLOY_SHA}`,
            repository: { full_name: "stella/stella" },
          },
        ],
      },
    },
  ],
  [`GET repos/stella/stella/commits/${DEPLOY_SHA}/statuses`]: [{ body: [[]] }],
  ...overrides,
});

type LogEntry = {
  key: string;
  token: string;
  fields: readonly string[];
  body: string;
};

/** One request the fake gh-retry.sh logged. */
const parseLogEntry = (line: string): LogEntry => {
  const entry: unknown = JSON.parse(line);
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("key" in entry && typeof entry.key === "string") ||
    !("token" in entry && typeof entry.token === "string") ||
    !("body" in entry && typeof entry.body === "string") ||
    !("fields" in entry && Array.isArray(entry.fields))
  ) {
    throw new TypeError(`Unexpected fake request log entry: ${line}`);
  }
  const fields: unknown[] = entry.fields;
  return {
    key: entry.key,
    token: entry.token,
    body: entry.body,
    fields: fields.map(String),
  };
};

type Wake = {
  exitCode: number;
  stdout: string;
  output: string;
  summary: string;
  log: readonly LogEntry[];
  probes: number;
};

let workspace = "";

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "staging-wake-"));
  for (const [name, source] of Object.entries({
    "gh-retry.sh": FAKE_GH_RETRY,
    curl: FAKE_CURL,
    sleep: FAKE_SLEEP,
  })) {
    const file = path.join(workspace, name);
    await writeFile(file, source);
    await chmod(file, 0o755);
  }
});

afterAll(async () => {
  await rm(workspace, { force: true, recursive: true });
});

/** A file the fakes write only once they are called; absent reads as empty. */
const readOptional = async (file: string): Promise<string> =>
  existsSync(file) ? readFile(file, "utf-8") : "";

const wake = async ({
  env = {},
  fixture = baseFixture(),
  readyAfter = "1",
}: {
  env?: Record<string, string>;
  fixture?: Fixture;
  readyAfter?: string;
}): Promise<Wake> => {
  const root = await mkdtemp(path.join(workspace, "case-"));
  await Promise.all([
    writeFile(path.join(root, "fixture.json"), JSON.stringify(fixture)),
    writeFile(path.join(root, "output"), ""),
    writeFile(path.join(root, "summary"), ""),
  ]);
  const result = Bun.spawnSync(["bash", SCRIPT], {
    env: {
      PATH: `${workspace}:${process.env["PATH"] ?? ""}`,
      HOME: process.env["HOME"] ?? root,
      FAKE_ROOT: root,
      FAKE_READY_AFTER: readyAfter,
      GH_RETRY_SCRIPT: path.join(workspace, "gh-retry.sh"),
      GH_TOKEN: "repo-token",
      STAGING_POWER_TOKEN: "power-token",
      INFRA_REPO,
      DEPLOY_SHA,
      GITHUB_REPOSITORY: "stella/stella",
      GITHUB_RUN_ID: "9",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_OUTPUT: path.join(root, "output"),
      GITHUB_STEP_SUMMARY: path.join(root, "summary"),
      STAGING_HEALTH_URL: "https://api-staging.stll.app/ready",
      ...env,
    },
  });
  const log = (await readOptional(path.join(root, "log")))
    .split("\n")
    .filter((line) => line !== "")
    .map(parseLogEntry);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString() + result.stderr.toString(),
    output: await readOptional(path.join(root, "output")),
    summary: await readOptional(path.join(root, "summary")),
    log,
    probes: Number((await readOptional(path.join(root, "probes"))) || "0"),
  };
};

const statusWrites = (result: Wake) =>
  result.log.filter(({ key }) => key === STATUS_ENDPOINT);

const expectRefusal = (result: Wake, description: string) => {
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("deploy=false");
  expect(result.output).not.toContain("deploy=true");
  const writes = statusWrites(result);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.token).toBe("repo-token");
  expect(JSON.parse(writes[0]?.body ?? "{}")).toEqual({
    state: "error",
    context: "staging/verified",
    description,
    target_url: "https://github.com/stella/stella/actions/runs/9",
  });
  expect(result.stdout).toContain(
    "Nothing was deployed: https://github.com/stella/stella/actions/runs/9",
  );
};

describe("staging wake for a release candidate", () => {
  test("starts staging with a 2 h lease, waits for it, and deploys once ready", async () => {
    const result = await wake({ readyAfter: "3" });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("deploy=true\n");
    expect(statusWrites(result)).toEqual([]);
    const dispatches = result.log.filter(
      ({ key }) => key === DISPATCH_ENDPOINT,
    );
    expect(dispatches).toEqual([
      {
        key: DISPATCH_ENDPOINT,
        token: "power-token",
        fields: ["ref=main", "inputs[action]=on", "inputs[hours]=2"],
        body: "",
      },
    ]);
    // Every infra request carries the App token, never the repository's.
    expect(
      result.log
        .filter(({ key }) => key.includes(INFRA_REPO))
        .every(({ token }) => token === "power-token"),
    ).toBe(true);
    expect(result.log.map(({ key }) => key)).toEqual([
      DISPATCH_ENDPOINT,
      RUNS_ENDPOINT,
      RUNS_ENDPOINT,
      RUN_ENDPOINT,
      RUN_ENDPOINT,
    ]);
    expect(result.probes).toBe(3);
  });

  test("refuses when the start run concludes failure, without probing", async () => {
    const result = await wake({
      fixture: baseFixture({
        [RUN_ENDPOINT]: [run("completed", "failure")],
      }),
    });

    expectRefusal(result, "staging start failed");
    expect(result.stdout).toContain(
      "The staging start run concluded 'failure': https://github.com/example/infra/actions/runs/77",
    );
    expect(result.summary).toContain("Staging did not start");
    expect(result.probes).toBe(0);
  });

  test("refuses when /ready never answers within the bound", async () => {
    const result = await wake({
      env: { STAGING_WAKE_READY_MINUTES: "0" },
      readyAfter: "never",
    });

    expectRefusal(result, "staging not ready within 0 min");
    expect(result.stdout).toContain(
      "Staging started (https://github.com/example/infra/actions/runs/77) but was not ready within 0 minutes.",
    );
    expect(result.probes).toBe(1);
  });

  test("refuses a start run that does not finish within its bound", async () => {
    const result = await wake({
      env: { STAGING_WAKE_START_MINUTES: "0" },
      fixture: baseFixture({ [RUN_ENDPOINT]: [run("in_progress", null)] }),
    });

    expectRefusal(result, "staging start timed out");
    expect(result.stdout).toContain(
      "did not finish within 0 minutes: https://github.com/example/infra/actions/runs/77",
    );
    expect(result.log.filter(({ key }) => key === RUN_ENDPOINT)).toHaveLength(
      1,
    );
  });

  test("gives up on a run that never appears after the named number of reads", async () => {
    const result = await wake({
      env: { STAGING_WAKE_LOOKUP_ATTEMPTS: "3" },
      fixture: baseFixture({
        [RUNS_ENDPOINT]: [{ body: { workflow_runs: [] } }],
      }),
    });

    expectRefusal(result, "staging start failed");
    expect(result.stdout).toContain("did not appear after 3 reads");
    expect(result.log.filter(({ key }) => key === RUNS_ENDPOINT)).toHaveLength(
      3,
    );
  });

  test("refuses when more than one matching run started since the dispatch", async () => {
    const result = await wake({
      fixture: baseFixture({
        [RUNS_ENDPOINT]: [
          {
            body: {
              workflow_runs: [
                powerRun(77, AFTER_DISPATCH, "Staging power on (2h)"),
                powerRun(80, AFTER_DISPATCH, "Staging power on (2h)"),
              ],
            },
          },
        ],
      }),
    });

    expectRefusal(result, "staging start ambiguous");
    expect(result.log.some(({ key }) => key === RUN_ENDPOINT)).toBe(false);
  });

  test("refuses without dispatching when no token or target is available", async () => {
    const tokenless = await wake({ env: { STAGING_POWER_TOKEN: "" } });
    expectRefusal(tokenless, "staging start failed");
    expect(tokenless.log.map(({ key }) => key)).toEqual([
      ...OWNERSHIP_ENDPOINTS,
      STATUS_ENDPOINT,
    ]);

    const unconfigured = await wake({ env: { INFRA_REPO: "example/" } });
    expectRefusal(unconfigured, "staging start not configured");
    expect(unconfigured.log.map(({ key }) => key)).toEqual([
      ...OWNERSHIP_ENDPOINTS,
      STATUS_ENDPOINT,
    ]);
  });

  test("a failed dispatch refuses and is not repeated", async () => {
    const result = await wake({
      fixture: baseFixture({ [DISPATCH_ENDPOINT]: [{ exit: 1 }] }),
    });

    expectRefusal(result, "staging start failed");
    expect(result.log.map(({ key }) => key)).toEqual([
      DISPATCH_ENDPOINT,
      ...OWNERSHIP_ENDPOINTS,
      STATUS_ENDPOINT,
    ]);
  });

  test("never powers staging off and sends only the inputs the workflow takes", async () => {
    const source = await readFile(SCRIPT, "utf-8");
    expect(source).not.toContain("inputs[action]=off");
    expect(
      [...source.matchAll(/-f "inputs\[(\w+)\]=/gu)].map((match) => match[1]),
    ).toEqual(["action", "hours"]);
  });
});

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jobs = async (): Promise<Record<string, Record<string, unknown>>> => {
  const parsed: unknown = Bun.YAML.parse(await readFile(WORKFLOW, "utf-8"));
  const all = record(parsed) ? parsed["jobs"] : undefined;
  if (!record(all)) {
    throw new TypeError("deploy-staging.yml has no jobs");
  }
  return Object.fromEntries(
    Object.entries(all).flatMap(([name, job]) =>
      record(job) ? [[name, job]] : [],
    ),
  );
};

/** The decide step of staging-health, as the runner executes it. */
const decideScript = async (): Promise<string> => {
  const workflow = await readFile(WORKFLOW, "utf-8");
  const stepStart = workflow.indexOf(
    "      - name: Decide whether staging can deploy\n",
  );
  const bodyStart = workflow.indexOf("run: |\n", stepStart) + "run: |\n".length;
  const end = /^ {0,2}\S/mu.exec(workflow.slice(bodyStart));
  if (stepStart === -1 || end === null) {
    throw new Error("deploy-staging.yml no longer exposes the decide step");
  }
  return workflow
    .slice(bodyStart, bodyStart + end.index)
    .split("\n")
    .map((line) => line.slice("          ".length))
    .join("\n");
};

describe("the wake in deploy-staging.yml", () => {
  test("a dispatch that is not a release candidate never reaches the infra repository", async () => {
    const script = path.join(workspace, "decide.sh");
    await writeFile(script, await decideScript());
    const decide = async (releaseCandidate: boolean) => {
      const root = await mkdtemp(path.join(workspace, "decide-"));
      await writeFile(
        path.join(root, "fixture.json"),
        JSON.stringify(baseFixture()),
      );
      const result = Bun.spawnSync(["bash", script], {
        env: {
          PATH: `${workspace}:${process.env["PATH"] ?? ""}`,
          FAKE_ROOT: root,
          GH_RETRY_SCRIPT: path.join(workspace, "gh-retry.sh"),
          STAGING_STATUS_WRITER: path.join(
            import.meta.dir,
            "post-staging-verification.sh",
          ),
          GH_TOKEN: "repo-token",
          DEPLOY_SHA,
          DEPLOY_WHEN_UNREACHABLE: "false",
          RELEASE_CANDIDATE: String(releaseCandidate),
          STATUS: "not_ready",
          GITHUB_REPOSITORY: "stella/stella",
          GITHUB_RUN_ID: "9",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_OUTPUT: path.join(root, "output"),
          GITHUB_STEP_SUMMARY: path.join(root, "summary"),
        },
      });
      const log = await readOptional(path.join(root, "log"));
      return {
        exitCode: result.exitCode,
        keys: log
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => parseLogEntry(line).key),
        output: await readOptional(path.join(root, "output")),
      };
    };

    const ordinary = await decide(false);
    expect(ordinary.exitCode).toBe(1);
    expect(ordinary.keys).toEqual([...OWNERSHIP_ENDPOINTS, STATUS_ENDPOINT]);
    expect(ordinary.output).toBe("deploy=false\n");

    const candidate = await decide(true);
    expect(candidate.exitCode).toBe(0);
    expect(candidate.keys).toEqual([]);
    expect(candidate.output).toBe("deploy=false\nwake=true\n");
  });

  test("runs only for a pinned release candidate that found staging off", async () => {
    const { "staging-wake": job } = await jobs();
    expect(job?.["if"]).toBe(
      "github.ref == 'refs/heads/main' && inputs.release_candidate == true && inputs.sha != '' && needs.staging-health.outputs.wake == 'true'",
    );
    expect(job?.["environment"]).toBe("release-app");
    expect(job?.["timeout-minutes"]).toBe(70);
    const rawSteps: unknown = job?.["steps"];
    const steps = Array.isArray(rawSteps) ? rawSteps.filter(record) : [];
    const wakeStep = steps.find((step) => step["id"] === "wake");
    expect(wakeStep?.["run"]).toBe("bash .gh-retry/scripts/staging-wake.sh");
    // The step bound covers the script's: 15 + 45 minutes of waiting.
    expect(wakeStep?.["timeout-minutes"]).toBe(65);
  });

  test("only the wake and promote jobs hold the App key", async () => {
    const all = await jobs();
    expect(
      Object.entries(all)
        .filter(([, job]) =>
          JSON.stringify(job).includes("STELLA_RELEASE_APP_PRIVATE_KEY"),
        )
        .map(([name]) => name)
        .toSorted(),
    ).toEqual(["promote-staging", "staging-wake"]);
    expect(all["staging-health"]?.["environment"]).toBeUndefined();
  });

  test("promotes whenever both builds succeeded, whether or not staging needed a wake", async () => {
    const { "promote-staging": job } = await jobs();
    expect(job?.["needs"]).toEqual([
      "resolve",
      "staging-health",
      "staging-wake",
      "rc-manifest",
      "build-api",
      "build-web",
    ]);
    // Without a status function a skipped wake two levels up would skip the
    // promotion and end the run green with nothing deployed.
    expect(job?.["if"]).toBe(
      "!cancelled() && github.ref == 'refs/heads/main' && needs.resolve.result == 'success' && ((inputs.release_ref != '' && needs.rc-manifest.result == 'success' && (needs.staging-health.outputs.deploy == 'true' || needs.staging-wake.outputs.deploy == 'true')) || (needs.build-api.result == 'success' && needs.build-web.result == 'success'))",
    );
  });

  test("builds after the health check or after a successful wake", async () => {
    const all = await jobs();
    for (const name of ["build-api", "build-web"]) {
      expect(all[name]?.["needs"]).toEqual([
        "resolve",
        "staging-health",
        "staging-wake",
      ]);
      expect(all[name]?.["if"]).toBe(
        "!cancelled() && inputs.release_ref == '' && github.ref == 'refs/heads/main' && (needs.staging-health.outputs.deploy == 'true' || needs.staging-wake.outputs.deploy == 'true')",
      );
    }
  });
});
