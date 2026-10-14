import { describe, expect, test } from "bun:test";

import {
  evaluate,
  networkViolations,
  parseAllowlist,
  scanShell,
} from "./check-ci-network-steps";

const WORKFLOW = ".github/workflows/fixture.yml";

type Files = Record<string, string>;

const repository = (files: Files) => ({
  read: (file: string) => files[file] ?? null,
});

const workflow = (steps: string) => `name: Fixture
on: pull_request
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
${steps}`;

const check = (files: Files, allowlist: readonly string[] = []) => {
  const workflows = Object.keys(files).filter((file) =>
    file.startsWith(".github/workflows/"),
  );
  const actions = Object.keys(files).filter((file) =>
    file.endsWith("/action.yml"),
  );
  return evaluate(
    networkViolations(repository(files), workflows, actions),
    allowlist,
  );
};

describe("run step fetches", () => {
  test("a curl wrapped in retry.sh with a step timeout passes", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Download tool
        timeout-minutes: 2
        run: bash scripts/retry.sh curl -fsSL https://example.com/tool -o tool
`),
    });

    expect(report.errors).toEqual([]);
  });

  test("a bare curl fails the retry rule", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Download tool
        timeout-minutes: 2
        run: curl -fsSL https://example.com/tool -o tool
`),
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Download tool: route curl (${WORKFLOW}) through scripts/retry.sh`,
    ]);
  });

  test("a wrapped fetch without a step timeout fails the timeout rule", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Install dependencies
        run: bash scripts/retry.sh bun ci --ignore-scripts
`),
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Install dependencies: bun install (${WORKFLOW}) needs a step timeout-minutes`,
    ]);
  });

  test("a retried GitHub release download passes", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Download assets
        timeout-minutes: 3
        run: bash "$GH_RETRY_SCRIPT" release download v1 --dir assets
`),
    });

    expect(report.errors).toEqual([]);
  });
});

describe("shell detection", () => {
  test("loopback readiness probes are not fetches", () => {
    expect(
      scanShell(
        "until curl -fsS http://127.0.0.1:3000/health; do sleep 1; done",
        "probe",
      ),
    ).toEqual([]);
  });

  test("curl with its own retry-all-errors budget counts as retried", () => {
    expect(
      scanShell(
        "curl --fail --retry 3 --retry-all-errors https://example.com",
        "native",
      ).map((fetch) => fetch.wrapped),
    ).toEqual([true]);
  });

  test("messages and comments that name a fetch are not commands", () => {
    expect(
      scanShell(
        'echo "run bun install first"\n# docker pull happens later\n',
        "prose",
      ),
    ).toEqual([]);
  });

  test("a versioned remote package runner is a fetch, a local binary is not", () => {
    expect(
      scanShell("bunx turbo run build\nnpx cowsay@1.6.0 hi", "runner").map(
        (fetch) => fetch.kind,
      ),
    ).toEqual(["remote package runner"]);
  });
});

describe("scripts and composite actions", () => {
  test("a script invoked through retry.sh is retried as a whole", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        run: bash scripts/retry.sh bash scripts/install-tool.sh
`),
      "scripts/install-tool.sh":
        "curl -fsSL https://example.com/tool -o tool\n",
    });

    expect(report.errors).toEqual([]);
  });

  test("a fetch inside an invoked script needs the step timeout", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Install tool
        run: bash scripts/retry.sh bash scripts/install-tool.sh
`),
      "scripts/install-tool.sh":
        "curl -fsSL https://example.com/tool -o tool\n",
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Install tool: curl (scripts/install-tool.sh) needs a step timeout-minutes`,
    ]);
  });

  test("an unretried fetch inside an invoked script fails", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        run: bash scripts/install-tool.sh
`),
      "scripts/install-tool.sh":
        "curl -fsSL https://example.com/tool -o tool\n",
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Install tool: route curl (scripts/install-tool.sh) through scripts/retry.sh`,
    ]);
  });

  test("a bare invocation after a retried one still reports the script's fetch", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        run: |
          bash scripts/retry.sh bash scripts/install-tool.sh
          bash scripts/install-tool.sh
`),
      "scripts/install-tool.sh":
        "curl -fsSL https://example.com/tool -o tool\n",
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Install tool: route curl (scripts/install-tool.sh) through scripts/retry.sh`,
    ]);
  });

  const tool = {
    "scripts/install-tool.sh": "curl -fsSL https://example.com/tool -o tool\n",
  };
  const retryError = `${WORKFLOW}: build: Install tool: route curl (scripts/install-tool.sh) through scripts/retry.sh`;
  const timeoutError = `${WORKFLOW}: build: Install tool: curl (scripts/install-tool.sh) needs a step timeout-minutes`;

  test("a script behind a negated if is an invocation", () => {
    const report = check({
      ...tool,
      [WORKFLOW]: workflow(`      - name: Install tool
        run: if ! bash scripts/install-tool.sh; then exit 1; fi
`),
    });

    expect(report.errors).toEqual([retryError, timeoutError]);
  });

  test("a script in a command substitution is an invocation", () => {
    const report = check({
      ...tool,
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        run: X=$(bash scripts/install-tool.sh)
`),
    });

    expect(report.errors).toEqual([retryError]);
  });

  test("a retried and a bare invocation joined by && report the bare one", () => {
    const report = check({
      ...tool,
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        run: bash scripts/retry.sh bash scripts/install-tool.sh && bash scripts/install-tool.sh
`),
    });

    expect(report.errors).toEqual([retryError]);
  });

  test("a sourced library is followed", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        run: source scripts/lib.sh
`),
      "scripts/lib.sh": "curl -fsSL https://example.com/tool -o tool\n",
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Install tool: route curl (scripts/lib.sh) through scripts/retry.sh`,
    ]);
  });

  test("a script path in a case pattern is data, not an invocation", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Scope
        run: |
          case "$file" in
            docs/*|scripts/install-tool.sh) echo hit ;;
          esac
`),
      "scripts/install-tool.sh":
        "curl -fsSL https://example.com/tool -o tool\n",
    });

    expect(report.errors).toEqual([]);
  });

  test("a composite action that fetches needs the caller's step timeout", () => {
    const files = {
      ".github/actions/tool/action.yml": `name: Tool
runs:
  using: composite
  steps:
    - name: Install
      shell: bash
      run: bash "$GITHUB_ACTION_PATH/install.sh"
`,
      ".github/actions/tool/install.sh":
        'retry="$(dirname "$0")/../../../scripts/retry.sh"\nbash "$retry" curl -fsSL https://example.com/tool\n',
    };
    const report = check({
      ...files,
      [WORKFLOW]: workflow(`      - name: Install tool
        uses: ./.github/actions/tool
`),
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Install tool: curl (.github/actions/tool/install.sh) needs a step timeout-minutes`,
    ]);
  });
});

describe("allowlist", () => {
  const bare = {
    [WORKFLOW]: workflow(`      - name: Send alert
        timeout-minutes: 2
        run: curl -X POST https://example.com/hook
`),
  };

  test("an allowlisted violation passes", () => {
    const report = check(bare, [`${WORKFLOW}#build#Send alert#retry`]);

    expect(report).toEqual({ errors: [], allowlisted: 1 });
  });

  test("a stale allowlist entry fails so the list only shrinks", () => {
    const report = check(
      {
        [WORKFLOW]: workflow(`      - name: Send alert
        timeout-minutes: 2
        run: bash scripts/retry.sh curl https://example.com/feed
`),
      },
      [`${WORKFLOW}#build#Send alert#retry`],
    );

    expect(report.errors).toEqual([
      `scripts/ci-network-steps-allowlist.json: stale entry ${WORKFLOW}#build#Send alert#retry; the step complies or is gone, so delete the entry`,
    ]);
  });

  test("every entry needs a reason", () => {
    expect(() =>
      parseAllowlist(
        JSON.stringify([
          { id: `${WORKFLOW}#build#Send alert#retry`, reason: " " },
        ]),
        "fixture",
      ),
    ).toThrow("reason is required");
  });

  test("duplicate entries fail", () => {
    const entry = { id: `${WORKFLOW}#build#Send alert#retry`, reason: "Why." };
    expect(() =>
      parseAllowlist(JSON.stringify([entry, entry]), "fixture"),
    ).toThrow("duplicate entry");
  });
});
