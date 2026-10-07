import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import fixture from "./fixtures/network-baseline-selection/main-history.json" with { type: "json" };

const selector =
  process.env["NETWORK_BASELINE_SELECTOR_OVERRIDE"] ??
  new URL(
    "../.github/actions/prepare-network-baseline/select-recording.sh",
    import.meta.url,
  ).pathname;

type ReplayOptions = {
  walk?: string[];
  overrides?: Record<string, unknown>;
  failure?: { endpoint: string; reason: string };
  malformed?: string;
};

const replay = ({
  walk = fixture.walk,
  overrides = {},
  failure,
  malformed,
}: ReplayOptions = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), "network-selection-"));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(directory, "apps/web/e2e"), { recursive: true });
  writeFileSync(path.join(directory, "walk"), `${walk.join("\n")}\n`);
  writeFileSync(
    path.join(directory, "responses.json"),
    JSON.stringify({ ...fixture.responses, ...overrides }),
  );
  writeFileSync(path.join(directory, "summary"), "");
  const executable = (name: string, source: string) =>
    writeFileSync(path.join(bin, name), source, { mode: 0o755 });
  executable("git", '#!/bin/bash\ncat "$REPLAY_DIR/walk"\n');
  executable("bun", "#!/bin/bash\nexit 0\n");
  executable(
    "unzip",
    '#!/bin/bash\nmkdir -p "$4"\nprintf "{}" > "$4/network-baseline.json"\n',
  );
  executable(
    "gh",
    `#!/bin/bash
set -euo pipefail
endpoint=''
for argument in "$@"; do
  case "$argument" in
    name=network-baseline-main-*) endpoint="artifacts-\${argument#name=network-baseline-main-}" ;;
    repos/*/actions/workflows/*/runs) endpoint=record-runs ;;
    repos/*/actions/runs/*) endpoint="run-\${argument##*/}" ;;
    repos/*/actions/artifacts/*/zip) printf 'archive'; exit 0 ;;
  esac
done
if [[ "$endpoint" == "\${REPLAY_FAILURE_ENDPOINT:-}" ]]; then
  printf '%s\\n' "$REPLAY_FAILURE_REASON" >&2
  exit 1
fi
if [[ "$endpoint" == "\${REPLAY_MALFORMED:-}" ]]; then
  printf 'not JSON'
  exit 0
fi
jq -e --arg key "$endpoint" '.[$key] // error("unrecorded API request: " + $key)' "$REPLAY_DIR/responses.json"
`,
  );
  try {
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        'set -euo pipefail; source "$SELECTOR"; printf "selected=%s recorded=%s\\n" "$recorded_source" "$recorded"',
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"]}`,
          SELECTOR: selector,
          REPLAY_DIR: directory,
          REPLAY_FAILURE_ENDPOINT: failure?.endpoint ?? "",
          REPLAY_FAILURE_REASON: failure?.reason ?? "",
          REPLAY_MALFORMED: malformed ?? "",
          REPOSITORY: "stella/stella",
          RUNNER_TEMP: directory,
          GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
          gh_retry_script: path.join(bin, "gh"),
          base: fixture.base,
        },
      },
    );
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      summary: readFileSync(path.join(directory, "summary"), "utf-8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("recorded main history selects the newest delivered ancestor and explains every visited commit", () => {
  expect(fixture.walk.at(-1)?.startsWith("6502b4e")).toBe(true);
  const result = replay();
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`selected=${fixture.expected} recorded=true`);
  for (const sha of fixture.walk.slice(
    0,
    fixture.walk.indexOf(fixture.expected) + 1,
  )) {
    expect(result.stderr).toContain(sha);
    expect(result.summary).toContain(sha);
  }
  expect(result.stderr).toContain("11457891846");
});

for (const endpoint of [
  `artifacts-${fixture.base}`,
  "record-runs",
  "run-37564499381",
]) {
  test(`API errors terminate selection with the reason: ${endpoint}`, () => {
    const result = replay({
      failure: { endpoint, reason: "GitHub API unavailable (503)" },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("GitHub API unavailable (503)");
    expect(result.summary).toContain("GitHub API unavailable (503)");
    expect(result.summary).not.toContain("committed bootstrap");
  });
  test(`malformed API responses terminate selection visibly: ${endpoint}`, () => {
    const result = replay({ malformed: endpoint });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/ERROR|invalid|unparsable/iu);
    expect(result.summary).toMatch(/ERROR|invalid|unparsable/iu);
    expect(result.summary).not.toContain("committed bootstrap");
  });
}

const deliveredRun = fixture.responses["run-37564499381"];
for (const change of [
  {
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_branch: "feature",
  },
  { path: ".github/workflows/ci.yml" },
  { event: "pull_request" },
  { conclusion: "failure" },
  { head_branch: "feature" },
  { head_repository: { full_name: "other/repository" } },
]) {
  test(`untrusted artifact is skipped with a verdict: ${JSON.stringify(change)}`, () => {
    const result = replay({
      walk: fixture.walk.slice(0, fixture.walk.indexOf(fixture.expected) + 1),
      overrides: { "run-37564499381": { ...deliveredRun, ...change } },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("recorded=false");
    expect(result.stderr).toContain("11457891846");
    expect(result.stderr).toMatch(/reject|skip|untrusted/iu);
    expect(result.summary).toContain("committed bootstrap");
  });
}

test("an empty recording list retains the committed bootstrap with an explicit message", () => {
  const result = replay({
    walk: fixture.walk.slice(0, 3),
    overrides: { "record-runs": { total_count: 0, workflow_runs: [] } },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("selected= recorded=false");
  expect(result.summary).toContain(
    `committed bootstrap at merge base ${fixture.base} (recording unavailable)`,
  );
});

for (const [endpoint, response] of [
  [
    `artifacts-${fixture.base}`,
    { total_count: 1, artifacts: [{ id: "wrong type" }] },
  ],
  [
    "record-runs",
    { workflow_runs: [{ event: "schedule", head_sha: "invalid" }] },
  ],
  ["run-37564499381", { ...deliveredRun, head_repository: null }],
] as const) {
  test(`well-formed JSON with an invalid API shape fails: ${endpoint}`, () => {
    const result = replay({ overrides: { [endpoint]: response } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unparsable");
    expect(result.summary).not.toContain("committed bootstrap");
  });
}

for (const event of ["schedule", "workflow_dispatch"]) {
  test(`a successful main ${event} run can publish directly through reusable delivery`, () => {
    const result = replay({
      overrides: {
        "run-37564499381": {
          ...deliveredRun,
          path: ".github/workflows/network-baseline-record.yml",
          event,
          head_sha: fixture.expected,
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `selected=${fixture.expected} recorded=true`,
    );
  });
}

test("a recording artifact cannot claim a different main commit", () => {
  const result = replay({
    walk: fixture.walk.slice(0, fixture.walk.indexOf(fixture.expected) + 1),
    overrides: {
      "run-37564499381": {
        ...deliveredRun,
        path: ".github/workflows/network-baseline-record.yml",
        event: "workflow_dispatch",
        head_sha: fixture.base,
      },
    },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("recorded=false");
  expect(result.stderr).toContain("verdict=skipped");
});

test("a retained delivery from an earlier push recorder remains eligible", () => {
  const result = replay({
    overrides: {
      "record-runs": {
        total_count: 1,
        workflow_runs: [{ event: "push", head_sha: fixture.expected }],
      },
    },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`selected=${fixture.expected} recorded=true`);
});
