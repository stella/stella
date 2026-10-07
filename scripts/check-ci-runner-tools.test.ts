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

import {
  runnerToolProblems,
  runnerTools,
  selfHostedProfiles,
  TOOL_PACKAGES,
  toolchainLockTools,
} from "./check-ci-runner-tools";

type FixtureOptions = { jobs: unknown; files?: Record<string, string> };
const withFixture = (
  { jobs, files = {} }: FixtureOptions,
  check: (root: string) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-tools-"));
  try {
    for (const [name, source] of Object.entries({
      ".github/workflows/test.yml": Bun.YAML.stringify({ jobs }),
      ...files,
    })) {
      const file = path.join(root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const problems = (root: string) =>
  runnerToolProblems({
    root,
    workflow: ".github/workflows/test.yml",
    repository: "stella/stella-infra",
  });

const hostedJob = (steps: unknown[]) => ({
  "runs-on": "ubuntu-24.04-arm",
  steps,
});

test("every tracked executable is rejected on an unknown image and accepted after its own package install", () => {
  for (const [tool, packages] of Object.entries(TOOL_PACKAGES)) {
    for (const pkg of packages) {
      for (const installer of [
        "sudo apt-get install -y",
        "brew install",
        "apk add",
      ]) {
        withFixture(
          {
            jobs: {
              missing: {
                "runs-on": "custom",
                steps: [{ run: `${tool} --version` }],
              },
              installed: {
                "runs-on": "custom",
                steps: [
                  { run: `${installer} ${pkg}` },
                  { run: `${tool} --version` },
                ],
              },
            },
          },
          (root) => {
            const result = problems(root);
            expect(result).toHaveLength(1);
            expect(result.at(0)).toContain(`/missing/0`);
            expect(result.at(0)).toContain(`requires ${tool}`);
          },
        );
      }
    }
  }
});

test("nested parallel checks see sibling installs only after the group", () => {
  withFixture(
    {
      jobs: {
        check: {
          "runs-on": "unknown",
          steps: [
            {
              parallel: [
                { run: "sudo apt-get install -y ripgrep" },
                {
                  parallel: [
                    { name: "Nested invocation", run: "rg --version" },
                  ],
                },
              ],
            },
            { run: "rg --version" },
          ],
        },
      },
    },
    (root) => {
      const findings = problems(root);
      expect(findings).toHaveLength(1);
      expect(findings.at(0)).toContain("Nested invocation");
      expect(findings.at(0)).toContain("requires rg");
    },
  );
});

test("parallel groups wait for background installs without sharing them with siblings", () => {
  withFixture(
    {
      jobs: {
        check: {
          "runs-on": "unknown",
          steps: [
            {
              parallel: [
                {
                  id: "tools",
                  background: true,
                  run: "sudo apt-get install -y ripgrep",
                },
                { name: "Concurrent invocation", run: "rg --version" },
              ],
            },
            { name: "After group", run: "rg --version" },
          ],
        },
      },
    },
    (root) => {
      const findings = problems(root);
      expect(findings).toHaveLength(1);
      expect(findings.at(0)).toContain("Concurrent invocation");
    },
  );
});

test("background runner-tool installs take effect only after a wait", () => {
  withFixture(
    {
      jobs: {
        check: {
          "runs-on": "unknown",
          steps: [
            {
              id: "tools",
              background: true,
              run: "sudo apt-get install -y ripgrep",
            },
            { name: "Before wait", run: "rg --version" },
            { wait: "tools" },
            { name: "After wait", run: "rg --version" },
          ],
        },
      },
    },
    (root) => {
      const findings = problems(root);
      expect(findings).toHaveLength(1);
      expect(findings.at(0)).toContain("Before wait");
    },
  );
});

test("cancelled background tools stay unavailable after a wait barrier", () => {
  for (const barrier of [{ wait: "cancelled" }, { "wait-all": null }]) {
    withFixture(
      {
        jobs: {
          check: {
            "runs-on": "unknown",
            steps: [
              {
                id: "cancelled",
                background: true,
                run: "sudo apt-get install -y ripgrep",
              },
              { cancel: "cancelled" },
              barrier,
              { name: "After cancel", run: "rg --version" },
              {
                id: "retained",
                background: true,
                run: "sudo apt-get install -y ripgrep",
              },
              { wait: "retained" },
              { name: "After retained wait", run: "rg --version" },
            ],
          },
        },
      },
      (root) => {
        const findings = problems(root);
        expect(findings, JSON.stringify(barrier)).toHaveLength(1);
        expect(findings.at(0), JSON.stringify(barrier)).toContain(
          "After cancel",
        );
      },
    );
  }
});

test("parallel cancellation dominates sibling waits and nested group proofs while preserving completed tools", () => {
  for (const installLocation of ["before-group", "nested-sibling"] as const) {
    for (const depth of [0, 1, 2]) {
      for (const siblingWaitPosition of [
        "absent",
        "before",
        "after",
      ] as const) {
        for (const barrier of [{ wait: "tools" }, { "wait-all": null }]) {
          let cancelBranch: unknown = { cancel: "tools" };
          for (let nested = 0; nested < depth; nested += 1) {
            cancelBranch = { parallel: [cancelBranch] };
          }
          const siblingWait = { wait: "tools" };
          const parallel = [cancelBranch];
          if (siblingWaitPosition === "before") {
            parallel.unshift(siblingWait);
          }
          if (siblingWaitPosition === "after") {
            parallel.push(siblingWait);
          }
          const installerBranch = {
            parallel: [
              {
                id: "tools",
                background: true,
                run: "sudo apt-get install -y ripgrep",
              },
            ],
          };
          if (installLocation === "nested-sibling") {
            parallel.unshift(installerBranch);
          }
          const scenario = {
            installLocation,
            depth,
            siblingWaitPosition,
            barrier,
          };
          withFixture(
            {
              jobs: {
                check: {
                  "runs-on": "unknown",
                  steps: [
                    { run: "sudo apt-get install -y jq" },
                    ...(installLocation === "before-group"
                      ? [
                          {
                            id: "tools",
                            background: true,
                            run: "sudo apt-get install -y ripgrep",
                          },
                        ]
                      : []),
                    { parallel },
                    barrier,
                    { name: "After cancel", run: "rg --version" },
                    { name: "Completed tool proof", run: "jq --version" },
                  ],
                },
              },
            },
            (root) => {
              const findings = problems(root);
              expect(findings, JSON.stringify(scenario)).toHaveLength(1);
              expect(findings.at(0), JSON.stringify(scenario)).toContain(
                "After cancel",
              );
            },
          );
        }
      }
    }
  }
});

test("malformed step metadata and execution settings are reported without coercion", () => {
  withFixture(
    {
      jobs: {
        invalid: {
          "runs-on": "custom",
          steps: [
            { name: { label: "install" }, run: "jq --version" },
            { shell: { command: "bash" }, run: "jq --version" },
            {
              "working-directory": ["infra"],
              run: "jq --version",
            },
          ],
        },
      },
    },
    (root) => {
      expect(problems(root)).toEqual([
        expect.stringContaining("name must be a string"),
        expect.stringContaining("shell must be a string"),
        expect.stringContaining("working-directory must be a string"),
      ]);
    },
  );
});

test("runner defaults are specific to the image and do not leak into containers", () => {
  for (const runner of [
    "ubuntu-latest",
    "ubuntu-24.04",
    "ubuntu-24.04-arm",
    "windows-latest",
    "macos-14",
  ]) {
    expect(runnerTools(runner, undefined).has("jq"), runner).toBe(true);
    expect(runnerTools(runner, undefined).has("rg"), runner).toBe(false);
    expect(runnerTools(runner, undefined).has("fd"), runner).toBe(false);
    expect(runnerTools(runner, { image: "ubuntu:24.04" }).size, runner).toBe(0);
  }
  expect(runnerTools(["self-hosted", "custom"], undefined).size).toBe(0);
  // A self-hosted label provides only what its declared profile lists, and
  // only for the exact [self-hosted, label] pair outside a container.
  const declared = new Map([["mini-infra-deploy", new Set(["jq"])]]);
  const deployRunner = ["self-hosted", "mini-infra-deploy"];
  expect(runnerTools(deployRunner, undefined).size).toBe(0);
  expect([...runnerTools(deployRunner, undefined, declared)]).toEqual(["jq"]);
  expect(
    runnerTools(deployRunner, { image: "ubuntu:24.04" }, declared).size,
  ).toBe(0);
  expect(
    runnerTools(["self-hosted", "mini-infra"], undefined, declared).size,
  ).toBe(0);
  expect(
    runnerTools([...deployRunner, "extra"], undefined, declared).size,
  ).toBe(0);
  withFixture(
    {
      jobs: {
        plain: hostedJob([{ run: "jq --version" }]),
        container: {
          ...hostedJob([{ run: "jq --version" }]),
          container: "ubuntu:24.04",
        },
      },
    },
    (root) => {
      expect(problems(root)).toHaveLength(1);
      expect(problems(root).at(0)).toContain("/container/");
    },
  );
});

test("an install must precede the invocation in the same job and cover its conditional path", () => {
  for (const [installCondition, useCondition, allowed] of [
    [undefined, undefined, true],
    ["inputs.scan", "inputs.scan && success()", true],
    ["inputs.scan", undefined, false],
    ["inputs.scan", "inputs.other", false],
  ] as const) {
    withFixture(
      {
        jobs: {
          check: hostedJob([
            { if: installCondition, run: "sudo apt-get install -y ripgrep" },
            { if: useCondition, run: "rg foo file" },
          ]),
        },
      },
      (root) => expect(problems(root).length).toBe(allowed ? 0 : 1),
    );
  }
  withFixture(
    {
      jobs: {
        late: hostedJob([
          { run: "rg foo file" },
          { run: "sudo apt-get install -y ripgrep" },
        ]),
        other: hostedJob([{ run: "rg foo file" }]),
        optional: hostedJob([
          { "continue-on-error": true, run: "sudo apt-get install -y ripgrep" },
          { run: "rg foo file" },
        ]),
      },
    },
    (root) => expect(problems(root)).toHaveLength(3),
  );
  withFixture(
    {
      jobs: {
        check: hostedJob([
          { run: "sudo apt-get install -y ripgrep || true" },
          { run: "rg foo file" },
        ]),
      },
    },
    (root) => expect(problems(root)).toHaveLength(1),
  );
});

test("command substitutions, functions and wrappers expose tools while data and syntax-only checks do not", () => {
  const calls = [
    "rg foo file",
    "if ! rg foo file; then exit 1; fi",
    'value="$(rg foo file)"',
    "f() { rg foo file; }; f",
    "env KIND=check rg foo file",
    "timeout 5s rg foo file",
    "sudo -n rg foo file",
    "command rg foo file",
    "/usr/local/bin/rg foo file",
    "bash -c 'rg foo file'",
    "bash <<'SH'\nrg foo file\nSH",
  ];
  const data = [
    "echo 'rg fd jq'",
    "# rg foo\necho ok",
    "gh api repos/example --jq .id",
    "cat <<'SH'\nrg foo file\nSH",
    "bash -n scripts/missing-rg.sh",
  ];
  withFixture(
    {
      jobs: Object.fromEntries([
        ...calls.map((run, i) => [`call${i}`, hostedJob([{ run }])]),
        ...data.map((run, i) => [`data${i}`, hostedJob([{ run }])]),
      ]),
    },
    (root) => {
      const result = problems(root);
      expect(result).toHaveLength(calls.length);
      expect(result.every((entry) => entry.includes("/call"))).toBe(true);
    },
  );
});

test("new shell helpers and Python subprocess calls inherit every invoking job's tool contract", () => {
  withFixture(
    {
      jobs: {
        missing: hostedJob([
          { run: "bash scripts/check.sh\npython3 scripts/check.py" },
        ]),
        installed: hostedJob([
          { run: "sudo apt-get install -y ripgrep" },
          { run: "bash scripts/check.sh\npython3 scripts/check.py" },
        ]),
      },
      files: {
        "scripts/check.sh": "source scripts/nested.sh",
        "scripts/nested.sh": "rg foo file",
        "scripts/check.py":
          'import subprocess\nsubprocess.check_output(["rg", "--files"])',
      },
    },
    (root) => {
      const result = problems(root);
      expect(result).toHaveLength(2);
      expect(
        result.some((entry) => entry.includes("scripts/nested.sh requires rg")),
      ).toBe(true);
      expect(
        result.some((entry) => entry.includes("scripts/check.py requires rg")),
      ).toBe(true);
      expect(result.every((entry) => entry.includes("/missing/"))).toBe(true);
    },
  );
});

test("composite installation follows the caller condition rather than granting other paths", () => {
  withFixture(
    {
      jobs: {
        check: hostedJob([
          { if: "inputs.scan", uses: "./.github/actions/tools" },
          { run: "rg foo file" },
        ]),
      },
      files: {
        ".github/actions/tools/action.yml": Bun.YAML.stringify({
          runs: {
            using: "composite",
            steps: [{ shell: "bash", run: "sudo apt-get install -y ripgrep" }],
          },
        }),
      },
    },
    (root) => expect(problems(root)).toHaveLength(1),
  );
});

test("matrix runner profiles intersect their guarantees and PowerShell is not parsed as Bash", () => {
  withFixture(
    {
      jobs: {
        matrix: {
          "runs-on": `\${{ matrix.runner }}`,
          strategy: {
            matrix: {
              include: [{ runner: "windows-latest" }, { runner: "macos-14" }],
            },
          },
          steps: [
            { shell: "bash", run: "jq --version" },
            { shell: "pwsh", run: '$x = "PowerShell `"quotes`""' },
          ],
        },
      },
    },
    (root) => expect(problems(root)).toEqual([]),
  );
});

test("installer preview modes and fd-find do not provide the requested executable", () => {
  for (const run of [
    "sudo apt-get install --download-only ripgrep",
    "sudo apt-get install -d ripgrep",
    "apt install --simulate ripgrep",
    "apt-get install -s ripgrep",
    "apt-get install --dry-run ripgrep",
    "apt-get install --just-print ripgrep",
    "apt-get install --print-uris ripgrep",
    "apk add --simulate ripgrep",
    "apk add -s ripgrep",
    "brew install --dry-run ripgrep",
    "sudo apt-get install -y fd-find",
  ]) {
    const tool = run.includes("fd-find") ? "fd" : "rg";
    withFixture(
      { jobs: { check: hostedJob([{ run }, { run: `${tool} --version` }]) } },
      (root) => {
        expect(problems(root), run).toHaveLength(1);
        expect(problems(root).at(0), run).toContain(`requires ${tool}`);
      },
    );
  }
});

test("wrapper arguments and combined shell flags preserve executable inspection", () => {
  for (const run of [
    "sudo -u root rg --files",
    "sudo --user root --group root rg --files",
    "sudo -uroot rg --files",
    "command -- rg --files",
    "command -p -- rg --files",
    "bash -ec 'rg --files'",
    "bash -euc 'rg --files'",
    "sh -ec 'rg --files'",
  ]) {
    withFixture({ jobs: { check: hostedJob([{ run }]) } }, (root) =>
      expect(problems(root), run).toHaveLength(1),
    );
  }
  for (const run of ["bash -nec 'rg --files'", "command -v rg"]) {
    withFixture({ jobs: { check: hostedJob([{ run }]) } }, (root) =>
      expect(problems(root), run).toEqual([]),
    );
  }
  withFixture(
    {
      jobs: {
        check: hostedJob([
          { run: "sudo -u root apt-get install -y ripgrep" },
          { run: "command -- rg --files" },
        ]),
      },
    },
    (root) => expect(problems(root)).toEqual([]),
  );
});

test("extensionless shebang scripts and absolute Python argv executables retain the caller contract", () => {
  withFixture(
    {
      jobs: {
        missing: hostedJob([
          { run: "./scripts/check-shell\n./scripts/check-python" },
        ]),
        installed: hostedJob([
          { run: "sudo apt-get install -y ripgrep" },
          { run: "./scripts/check-shell\n./scripts/check-python" },
        ]),
      },
      files: {
        "scripts/check-shell": "#!/usr/bin/env bash\nrg --files",
        "scripts/check-python":
          '#!/usr/bin/env python3\nimport subprocess\nsubprocess.run(["/usr/local/bin/rg", "--files"])',
      },
    },
    (root) => {
      expect(problems(root)).toHaveLength(2);
      expect(
        problems(root).every((problem) => problem.includes("/missing/")),
      ).toBe(true);
    },
  );
});

test("subprocess examples in source comments and strings are data while literal argv calls require tools", () => {
  withFixture(
    {
      jobs: {
        data: hostedJob([
          { run: "python3 scripts/data.py\nnode scripts/data.js" },
        ]),
        calls: hostedJob([
          {
            run: "python3 scripts/calls.py\nnode scripts/calls.js\nbun scripts/calls.ts",
          },
        ]),
      },
      files: {
        "scripts/data.py": [
          '# subprocess.run(["rg", "--files"])',
          '"""subprocess.check_output(["rg", "--files"])"""',
          "'''subprocess.call(['rg', '--files'])'''",
          `example = 'subprocess.Popen(["rg", "--files"])'`,
          `example = "subprocess.run(['rg', '--files'])"`,
          'not_subprocess.run(["rg", "--files"])',
        ].join("\n"),
        "scripts/data.js": [
          '// Bun.spawn(["rg", "--files"]);',
          '/* spawnSync("rg", ["--files"]); */',
          `const example = 'execFile("rg", ["--files"])';`,
          'const template = `Bun.spawnSync(["rg", "--files"])`;',
          'const pattern = /spawn("rg")/;',
          'spawn("echo", ["rg"]);',
        ].join("\n"),
        "scripts/calls.py":
          'import subprocess\nsubprocess.run(["rg", "--files"])',
        "scripts/calls.js": 'spawnSync("/usr/local/bin/rg", ["--files"]);',
        "scripts/calls.ts": 'Bun.spawnSync(["rg", "--files"]);',
      },
    },
    (root) => {
      expect(problems(root)).toHaveLength(3);
      expect(
        problems(root).every((problem) => problem.includes("/calls/")),
      ).toBe(true);
    },
  );
});

test("nested conditional installs cannot provision later commands", () => {
  for (const run of [
    "if true; then bash scripts/install.sh; fi",
    "(bash scripts/install.sh)",
    "bash -c 'brew install ripgrep' || true",
  ]) {
    withFixture(
      {
        jobs: { check: hostedJob([{ run }, { run: "rg foo" }]) },
        files: { "scripts/install.sh": "brew install ripgrep" },
      },
      (root) => {
        expect(problems(root)).toHaveLength(1);
      },
    );
  }
});

test("matrix include can add a runner without the axis defaults", () => {
  withFixture(
    {
      jobs: {
        check: {
          "runs-on": `\${{ matrix.os }}`,
          strategy: {
            matrix: { os: ["ubuntu-24.04"], include: [{ os: "custom" }] },
          },
          steps: [{ run: "jq --version" }],
        },
      },
    },
    (root) => expect(problems(root)).toHaveLength(1),
  );
});

test("event-selected runners each receive an installation contract", () => {
  for (const provision of [true, false]) {
    withFixture(
      {
        jobs: {
          check: {
            "runs-on": `\${{ github.event_name == 'schedule' && fromJSON('["self-hosted","custom"]') || 'ubuntu-24.04' }}`,
            steps: [
              ...(provision
                ? [
                    {
                      if: "github.event_name == 'schedule'",
                      run: "brew install jq",
                    },
                  ]
                : []),
              { run: "jq --version" },
              { if: "github.event_name != 'schedule'", run: "jq --version" },
            ],
          },
        },
      },
      (root) => expect(problems(root)).toHaveLength(provision ? 0 : 1),
    );
  }
});

test("local actions use workspace paths and optional composite installs do not persist", () => {
  withFixture(
    {
      jobs: {
        check: {
          ...hostedJob([
            { uses: "./.github/actions/install", "continue-on-error": true },
            { run: "rg foo" },
          ]),
          defaults: { run: { "working-directory": "subdir" } },
        },
      },
      files: {
        ".github/actions/install/action.yml":
          "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: brew install ripgrep\n",
      },
    },
    (root) => expect(problems(root)).toHaveLength(1),
  );
});

test("working directories and workspace path expressions retain reachable scripts", () => {
  for (const run of [
    "cd subdir\nbash check.sh",
    'bash "$GITHUB_WORKSPACE/subdir/check.sh"',
    `bash "\${GITHUB_WORKSPACE}/subdir/check.sh"`,
    `bash "\${{ github.workspace }}/subdir/check.sh"`,
  ]) {
    withFixture(
      {
        jobs: { check: hostedJob([{ run }]) },
        files: { "subdir/check.sh": "rg foo" },
      },
      (root) => expect(problems(root)).toHaveLength(1),
    );
  }
  withFixture(
    {
      jobs: {
        check: {
          ...hostedJob([{ run: 'bash "$GITHUB_WORKSPACE/check.sh"' }]),
          defaults: { run: { "working-directory": "subdir" } },
        },
      },
      files: { "check.sh": "rg foo" },
    },
    (root) => expect(problems(root)).toHaveLength(1),
  );
});

test("literal Node and Bun subprocess executables use the invoking job contract", () => {
  withFixture(
    {
      jobs: {
        check: hostedJob([
          { run: "bun scripts/check.ts" },
          { run: "node scripts/check.js" },
        ]),
      },
      files: {
        "scripts/check.ts": 'Bun.spawn(["rg", "--files"]);',
        "scripts/check.js": 'execFileSync("/usr/bin/fd", ["."]);',
      },
    },
    (root) => expect(problems(root)).toHaveLength(2),
  );
});

test("conditional cd scans both possible script locations", () => {
  withFixture(
    {
      jobs: {
        check: hostedJob([
          { run: "if condition; then cd subdir; fi\nbash check.sh" },
        ]),
      },
      files: {
        "check.sh": "rg foo",
        "subdir/check.sh": "echo ok",
      },
    },
    (root) => expect(problems(root)).toHaveLength(1),
  );
});

test("the CI owner runs the portable guard without depending on a dependency install", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8",
  );
  const step =
    / {6}- name: Verify runner tool availability\n([\s\S]*?)(?=\n {6}- name:)/u.exec(
      workflow,
    )?.[1];
  expect(step).toBeDefined();
  expect(step).toContain(
    "bun scripts/check-ci-runner-tools.ts . stella/stella",
  );
  expect(step).toContain("bun test scripts/check-ci-runner-tools.test.ts");
  expect(step).toContain("steps.checkout.outcome == 'success'");
  expect(step).not.toContain("package_checks_required");
  expect(step).not.toContain("continue-on-error");
});

test("shell option operands and own-checkout workspace aliases do not hide script calls", () => {
  withFixture(
    {
      jobs: {
        check: hostedJob([
          { uses: "actions/checkout@v7", with: { path: "repository" } },
          {
            run: `bash -o pipefail "\${{ github.workspace }}/repository/scripts/check.sh"`,
          },
          { run: "sh -- scripts/check.sh" },
        ]),
      },
      files: { "scripts/check.sh": "rg foo" },
    },
    (root) => expect(problems(root)).toHaveLength(2),
  );
});

test("own checkout working directory resolves to the inspected checkout root", () => {
  withFixture(
    {
      jobs: {
        check: {
          ...hostedJob([
            { uses: "actions/checkout@v7", with: { path: "infra" } },
            { run: "bash scripts/check.sh", "working-directory": "infra" },
          ]),
        },
      },
      files: { "scripts/check.sh": "rg foo" },
    },
    (root) => expect(problems(root)).toHaveLength(1),
  );
});

test("installing one tracked package never grants unrelated executable guarantees", () => {
  const tools = Object.keys(TOOL_PACKAGES);
  for (const [installed, packages] of Object.entries(TOOL_PACKAGES)) {
    for (const pkg of packages) {
      withFixture(
        {
          jobs: {
            check: {
              "runs-on": "unknown",
              steps: [
                { run: `brew install ${pkg}` },
                ...tools.map((tool) => ({ run: `${tool} --version` })),
              ],
            },
          },
        },
        (root) => {
          const findings = problems(root);
          expect(findings).toHaveLength(tools.length - 1);
          expect(
            findings.some((finding) =>
              finding.includes(`requires ${installed},`),
            ),
          ).toBe(false);
        },
      );
    }
  }
});

test("Bun run traverses literal script paths", () => {
  withFixture(
    {
      jobs: { check: hostedJob([{ run: "bun run scripts/check.ts" }]) },
      files: {
        "scripts/check.ts": 'Bun.spawn(["rg", "--files"]);',
      },
    },
    (root) => expect(problems(root)).toHaveLength(1),
  );
});

test("the deploy runner profile comes from the repository's toolchain lock", () => {
  expect([
    ...toolchainLockTools(
      [
        "# comment jq",
        "artifact coreutils 9.12 aaa https://example.invalid/c.tar.xz",
        "artifact jq 1.8.2 bbb https://example.invalid/jq",
        "artifact terraform 1.15.9 ccc https://example.invalid/t.zip",
        "pkg-team-id awscli X",
      ].join("\n"),
    ),
  ]).toEqual(["jq"]);
  const root = mkdtempSync(path.join(tmpdir(), "runner-tools-lock-"));
  try {
    expect(selfHostedProfiles(root).size).toBe(0);
    mkdirSync(path.join(root, "ci/deploy-runner"), { recursive: true });
    writeFileSync(
      path.join(root, "ci/deploy-runner/toolchain.lock"),
      "artifact jq 1.8.2 bbb https://example.invalid/jq\n",
    );
    expect([
      ...(selfHostedProfiles(root).get("mini-infra-deploy") ?? []),
    ]).toEqual(["jq"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deploy runner job gets exactly the tools its repository's toolchain lock pins", () => {
  const jobs = {
    deploy: {
      "runs-on": ["self-hosted", "mini-infra-deploy"],
      steps: [{ run: "jq --version" }],
    },
  };
  withFixture(
    {
      jobs,
      files: {
        "ci/deploy-runner/toolchain.lock":
          "artifact jq 1.8.2 bbb https://example.invalid/jq\n",
      },
    },
    (root) => expect(problems(root)).toEqual([]),
  );
  withFixture(
    {
      jobs,
      files: {
        "ci/deploy-runner/toolchain.lock":
          "artifact terraform 1.15.9 ccc https://example.invalid/t.zip\n",
      },
    },
    (root) => expect(problems(root).length).toBeGreaterThan(0),
  );
  withFixture({ jobs }, (root) =>
    expect(problems(root).length).toBeGreaterThan(0),
  );
});
