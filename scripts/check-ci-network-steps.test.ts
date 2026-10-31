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
  glob: (pattern: string) =>
    Object.keys(files).filter((file) => new Bun.Glob(pattern).match(file)),
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

describe("cargo dependency resolution", () => {
  const cargo = (command: string) =>
    scanShell(command, "cargo").map((fetch) => [fetch.kind, fetch.wrapped]);
  const resolution = "cargo dependency resolution";

  test("a cargo build, test or lint downloads missing crates", () => {
    expect(
      cargo(
        [
          "cargo check --workspace --locked",
          "cargo +1.99.0 test --locked",
          "cargo clippy --all-targets --locked -- -D warnings",
          "cargo doc --no-deps --locked",
          "cargo deny check advisories",
          "tauri build --target aarch64-apple-darwin",
        ].join("\n"),
      ),
    ).toEqual(Array.from({ length: 6 }, () => [resolution, false]));
  });

  test("an offline cargo command downloads nothing", () => {
    expect(
      cargo(
        [
          "cargo test --frozen --workspace",
          "cargo clippy --offline -- -D warnings",
          "cargo deny --offline check bans",
          "CARGO_NET_OFFLINE=true cargo build --release",
          "cargo metadata --no-deps --format-version 1",
          "cargo fmt -- --check",
          "cargo --version",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("an offline flag passed to the program under test is not cargo's", () => {
    expect(cargo("cargo test --locked -- --offline --exact")).toEqual([
      [resolution, false],
    ]);
  });

  test("a cargo command through retry.sh is retried", () => {
    expect(cargo("bash scripts/retry.sh cargo test --locked")).toEqual([
      [resolution, true],
    ]);
  });

  test("a bare cargo build in a step fails the retry rule", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Lint
        run: cargo clippy --manifest-path Cargo.toml --locked -- -D warnings
`),
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Lint: route ${resolution} (${WORKFLOW}) through scripts/retry.sh`,
      `${WORKFLOW}: build: Lint: ${resolution} (${WORKFLOW}) needs a step timeout-minutes`,
    ]);
  });

  test("a retried fetch then a frozen build passes", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Fetch Rust dependencies
        timeout-minutes: 10
        run: bash scripts/retry.sh cargo fetch --manifest-path Cargo.toml --locked
      - name: Lint
        run: cargo clippy --manifest-path Cargo.toml --frozen -- -D warnings
`),
    });

    expect(report.errors).toEqual([]);
  });

  const scoped = (jobEnv: string, stepEnv: string) => `name: Fixture
on: pull_request
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
${jobEnv}    steps:
      - name: Build
${stepEnv}        run: cargo build --locked
`;

  test("CARGO_NET_OFFLINE in the step or job env keeps cargo offline", () => {
    for (const source of [
      scoped("", `        env:\n          CARGO_NET_OFFLINE: "true"\n`),
      scoped(`    env:\n      CARGO_NET_OFFLINE: true\n`, ""),
    ]) {
      expect(check({ [WORKFLOW]: source }).errors).toEqual([]);
    }
  });

  test("a step env that turns CARGO_NET_OFFLINE off overrides the job", () => {
    const report = check({
      [WORKFLOW]: scoped(
        `    env:\n      CARGO_NET_OFFLINE: "true"\n`,
        `        env:\n          CARGO_NET_OFFLINE: "false"\n`,
      ),
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Build: route ${resolution} (${WORKFLOW}) through scripts/retry.sh`,
      `${WORKFLOW}: build: Build: ${resolution} (${WORKFLOW}) needs a step timeout-minutes`,
    ]);
  });

  test("a package script a step invokes is scanned", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Prepare toolchain
        timeout-minutes: 10
        run: bash packages/engine/scripts/toolchain.sh
`),
      "packages/engine/scripts/toolchain.sh":
        "cargo fetch --locked --target wasm32-unknown-unknown\n",
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Prepare toolchain: route cargo fetch/install (packages/engine/scripts/toolchain.sh) through scripts/retry.sh`,
    ]);
  });
});

describe("shell detection", () => {
  test("git network subcommands are fetches with or without global options", () => {
    for (const subcommand of ["clone", "fetch", "ls-remote", "pull"]) {
      expect(
        scanShell(`git ${subcommand} origin`, "git").map((fetch) => fetch.kind),
      ).toEqual([`git ${subcommand}`]);
      expect(
        scanShell(
          `git -c protocol.version=2 -C repo --no-pager --git-dir=.git --work-tree=. ${subcommand} origin`,
          "git",
        ).map((fetch) => fetch.kind),
      ).toEqual([`git ${subcommand}`]);
    }
  });

  test("git fetch through retry.sh counts as retried", () => {
    expect(
      scanShell("bash scripts/retry.sh git fetch origin main", "git").map(
        (fetch) => [fetch.kind, fetch.wrapped],
      ),
    ).toEqual([["git fetch", true]]);
  });

  test("quoted global option values with spaces still reveal the subcommand", () => {
    const command =
      'git -C "$directory" -c "http.extraheader=AUTHORIZATION: basic $auth" fetch --tags origin main';
    expect(
      scanShell(command, "git").map((fetch) => [fetch.kind, fetch.wrapped]),
    ).toEqual([["git fetch", false]]);
    expect(
      scanShell(`bash "$NETWORK_RETRY_SCRIPT" ${command}`, "git").map(
        (fetch) => [fetch.kind, fetch.wrapped],
      ),
    ).toEqual([["git fetch", true]]);
  });

  test("option values quoted inside a word still reveal the subcommand", () => {
    for (const command of [
      'git -c http.extraheader="Authorization: basic $auth" fetch origin main',
      'git --git-dir="repo with spaces/.git" fetch origin main',
    ]) {
      expect(
        scanShell(command, "git").map((fetch) => fetch.kind),
        command,
      ).toEqual(["git fetch"]);
    }
  });

  test("git commands without network access are not fetches", () => {
    expect(scanShell("git status\ngit rev-parse HEAD", "git")).toEqual([]);
  });

  test("loopback readiness probes are not fetches", () => {
    expect(
      scanShell(
        "until curl -fsS http://127.0.0.1:3000/health; do sleep 1; done",
        "probe",
      ),
    ).toEqual([]);
  });

  test("a hostname that only starts with a loopback name is remote", () => {
    expect(
      scanShell("curl -fsS http://localhost:3000/health", "probe"),
    ).toEqual([]);
    expect(
      scanShell(
        "curl -fsSL https://localhost.example.com/tool -o tool",
        "remote",
      ),
    ).toHaveLength(1);
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

  test("an apostrophe inside double quotes does not hide a substitution", () => {
    expect(
      scanShell(`echo "It's $(curl -fsSL https://example.com)"`, "quoted").map(
        (fetch) => [fetch.kind, fetch.wrapped],
      ),
    ).toEqual([["curl", false]]);
  });

  test("a versioned remote package runner is a fetch, a local binary is not", () => {
    expect(
      scanShell(
        "bunx turbo run build\nnpx cowsay@1.6.0 hi",
        "runner",
        new Set(["turbo"]),
      ).map((fetch) => fetch.kind),
    ).toEqual(["remote package runner"]);
  });
});

describe("package runners", () => {
  const manifests = {
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/tool/package.json": JSON.stringify({
      devDependencies: { turbo: "2.0.0" },
    }),
  };

  test("an unversioned package that is not a declared dependency is a fetch", () => {
    const report = check({
      ...manifests,
      [WORKFLOW]: workflow(`      - name: Greet
        run: npx cowsay hello
`),
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Greet: route remote package runner (${WORKFLOW}) through scripts/retry.sh`,
      `${WORKFLOW}: build: Greet: remote package runner (${WORKFLOW}) needs a step timeout-minutes`,
    ]);
  });

  test("an unversioned declared dependency runs locally", () => {
    const report = check({
      ...manifests,
      [WORKFLOW]: workflow(`      - name: Build
        run: bunx turbo run build
`),
    });

    expect(report.errors).toEqual([]);
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

  test("a curl in a substitution is not retried by an enclosing retry.sh", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        run: bash scripts/retry.sh echo "$(curl -fsSL https://example.com/tool)"
`),
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Install tool: route curl (${WORKFLOW}) through scripts/retry.sh`,
    ]);
  });

  test("a fetch script in a substitution is not retried by an enclosing retry.sh", () => {
    const report = check({
      ...tool,
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        run: bash scripts/retry.sh echo "\`bash scripts/install-tool.sh\`"
`),
    });

    expect(report.errors).toEqual([retryError]);
  });

  test("a substitution whose own command is retry.sh is retried", () => {
    const report = check({
      ...tool,
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        run: tool="$(bash scripts/retry.sh bash scripts/install-tool.sh)"
`),
    });

    expect(report.errors).toEqual([]);
  });

  test("a ./ script in a workflow step resolves from the repository root", () => {
    const report = check({
      ...tool,
      [WORKFLOW]: workflow(`      - name: Install tool
        run: bash ./scripts/install-tool.sh
`),
    });

    expect(report.errors).toEqual([retryError, timeoutError]);
  });

  test("a step working-directory resolves relative scripts", () => {
    const report = check({
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        working-directory: apps/web
        run: bash ./scripts/install-tool.sh
`),
      "apps/web/scripts/install-tool.sh":
        "curl -fsSL https://example.com/tool -o tool\n",
    });

    expect(report.errors).toEqual([
      `${WORKFLOW}: build: Install tool: route curl (apps/web/scripts/install-tool.sh) through scripts/retry.sh`,
    ]);
  });

  test("a workspace-anchored script resolves from the repository root", () => {
    const report = check({
      ...tool,
      [WORKFLOW]: workflow(`      - name: Install tool
        timeout-minutes: 2
        working-directory: apps/web
        run: bash "\${{ github.workspace }}/scripts/install-tool.sh"
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

  test("a script-directory variable resolves sibling scripts", () => {
    const files = {
      ".github/actions/tool/fetch.sh": `here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\nbash "$here/../../../scripts/retry.sh" bash "$here/fetch-once.sh" "$@"\n`,
      ".github/actions/tool/fetch-once.sh":
        "curl -fsSL https://example.com/tool -o tool\n",
    };

    expect(
      check({
        ...files,
        [WORKFLOW]: workflow(`      - name: Fetch tool
        run: bash .github/actions/tool/fetch.sh
`),
      }).errors,
    ).toEqual([
      `${WORKFLOW}: build: Fetch tool: curl (.github/actions/tool/fetch-once.sh) needs a step timeout-minutes`,
    ]);
    expect(
      check({
        ...files,
        [WORKFLOW]: workflow(`      - name: Fetch tool
        timeout-minutes: 5
        run: bash .github/actions/tool/fetch.sh
`),
      }).errors,
    ).toEqual([]);
  });

  test("a composite step working-directory resolves relative scripts", () => {
    const report = check({
      ".github/actions/tool/action.yml": `name: Tool
runs:
  using: composite
  steps:
    - name: Install
      shell: bash
      working-directory: apps/web
      run: bash ./scripts/install-tool.sh
`,
      "apps/web/scripts/install-tool.sh":
        "curl -fsSL https://example.com/tool -o tool\n",
      [WORKFLOW]: workflow(`      - name: Install tool
        uses: ./.github/actions/tool
`),
    });

    expect(report.errors.toSorted()).toEqual(
      [
        ".github/actions/tool/action.yml: Install: route curl (apps/web/scripts/install-tool.sh) through scripts/retry.sh",
        `${WORKFLOW}: build: Install tool: curl (apps/web/scripts/install-tool.sh) needs a step timeout-minutes`,
      ].toSorted(),
    );
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
