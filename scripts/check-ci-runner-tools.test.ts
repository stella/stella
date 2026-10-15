import { expect, test } from "bun:test";
import {
  existsSync,
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
  RunnerToolInvariantError,
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
    repository: "example/project",
    ...(existsSync(path.join(root, "runner-profile.json"))
      ? { profile: path.join(root, "runner-profile.json") }
      : {}),
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
              "working-directory": ["project"],
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
  const declared = new Map([
    ["example-provisioned", { tools: new Set(["jq"]) }],
  ]);
  const provisionedRunner = ["self-hosted", "example-provisioned"];
  expect(runnerTools(provisionedRunner, undefined).size).toBe(0);
  expect([...runnerTools(provisionedRunner, undefined, declared)]).toEqual([
    "jq",
  ]);
  expect(
    runnerTools(provisionedRunner, { image: "ubuntu:24.04" }, declared).size,
  ).toBe(0);
  expect(
    runnerTools(["self-hosted", "example-runner"], undefined, declared).size,
  ).toBe(0);
  expect(
    runnerTools([...provisionedRunner, "extra"], undefined, declared).size,
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
            { uses: "actions/checkout@v7", with: { path: "project" } },
            { run: "bash scripts/check.sh", "working-directory": "project" },
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

const nativeToolchainDirectory = path.join(
  tmpdir(),
  "example-runner-tools",
  "bin",
);
const profileSource = (runners: unknown[]) =>
  JSON.stringify({ version: 1, runners });
const nativeToolchainFiles = {
  "runner-profile.json": profileSource([
    {
      label: "example-runner",
      tools: [],
      toolchain: { directory: nativeToolchainDirectory, tools: ["jq"] },
    },
    {
      label: "example-provisioned",
      tools: ["jq"],
      toolchain: { directory: nativeToolchainDirectory, tools: ["jq"] },
    },
  ]),
};
const fixtureProfiles = (root: string) =>
  selfHostedProfiles(path.join(root, "runner-profile.json"));

test("self-hosted profiles are loaded only from an explicit file", () => {
  expect(selfHostedProfiles().size).toBe(0);
  withFixture(
    {
      jobs: {
        check: {
          "runs-on": ["self-hosted", "example-provisioned"],
          steps: [{ run: "jq --version" }],
        },
      },
      files: nativeToolchainFiles,
    },
    (root) => {
      expect(problems(root)).toEqual([]);
      expect(
        runnerToolProblems({
          root,
          workflow: ".github/workflows/test.yml",
          repository: "example/project",
        }),
      ).toHaveLength(1);
      expect([
        ...(fixtureProfiles(root).get("example-provisioned")?.tools ?? []),
      ]).toEqual(["jq"]);
    },
  );
});

test("an explicit profile accepts simple executable names beyond tracked tools", () => {
  withFixture(
    {
      jobs: {},
      files: {
        "runner-profile.json": profileSource([
          {
            label: "example-runner",
            tools: ["example-tool", "tool2", "tool.name"],
          },
        ]),
      },
    },
    (root) =>
      expect([
        ...(fixtureProfiles(root).get("example-runner")?.tools ?? []),
      ]).toEqual(["example-tool", "tool2", "tool.name"]),
  );
});

for (const [name, profile] of Object.entries({
  "unsupported version": { version: 2, runners: [] },
  "unknown root field": { version: 1, runners: [], extra: true },
  "missing runners": { version: 1 },
  "non-array runners": { version: 1, runners: {} },
  "null runner": { version: 1, runners: [null] },
  "unknown runner field": {
    version: 1,
    runners: [{ label: "example-runner", tools: [], extra: true }],
  },
  "non-string label": { version: 1, runners: [{ label: 1, tools: [] }] },
  "empty label": { version: 1, runners: [{ label: "", tools: [] }] },
  "duplicate labels": {
    version: 1,
    runners: [
      { label: "example-runner", tools: [] },
      { label: "example-runner", tools: [] },
    ],
  },
  "non-array tools": {
    version: 1,
    runners: [{ label: "example-runner", tools: "jq" }],
  },
  "non-string tool": {
    version: 1,
    runners: [{ label: "example-runner", tools: [1] }],
  },
  "invalid tool": {
    version: 1,
    runners: [{ label: "example-runner", tools: ["jq --version"] }],
  },
  "tool path": {
    version: 1,
    runners: [{ label: "example-runner", tools: ["/bin/jq"] }],
  },
  "unknown toolchain field": {
    version: 1,
    runners: [
      {
        label: "example-runner",
        tools: [],
        toolchain: {
          directory: nativeToolchainDirectory,
          tools: [],
          extra: true,
        },
      },
    ],
  },
  "relative directory": {
    version: 1,
    runners: [
      {
        label: "example-runner",
        tools: [],
        toolchain: { directory: "tools/bin", tools: ["jq"] },
      },
    ],
  },
  "noncanonical directory": {
    version: 1,
    runners: [
      {
        label: "example-runner",
        tools: [],
        toolchain: {
          directory: `${nativeToolchainDirectory}/../bin`,
          tools: ["jq"],
        },
      },
    ],
  },
  "non-string directory": {
    version: 1,
    runners: [
      {
        label: "example-runner",
        tools: [],
        toolchain: { directory: 1, tools: ["jq"] },
      },
    ],
  },
  "invalid toolchain tool": {
    version: 1,
    runners: [
      {
        label: "example-runner",
        tools: [],
        toolchain: { directory: nativeToolchainDirectory, tools: ["../jq"] },
      },
    ],
  },
})) {
  test(`invalid profile fails closed: ${name}`, () => {
    withFixture(
      { jobs: {}, files: { "runner-profile.json": JSON.stringify(profile) } },
      (root) => {
        expect(() => fixtureProfiles(root)).toThrow(RunnerToolInvariantError);
        expect(() => problems(root)).toThrow(RunnerToolInvariantError);
      },
    );
  });
}

for (const source of ["{", "null", "[]"]) {
  test(`invalid profile JSON fails closed: ${source}`, () => {
    withFixture(
      { jobs: {}, files: { "runner-profile.json": source } },
      (root) =>
        expect(() => fixtureProfiles(root)).toThrow(RunnerToolInvariantError),
    );
  });
}

test("a missing explicit profile fails closed", () => {
  withFixture({ jobs: {} }, (root) => {
    expect(() => selfHostedProfiles(path.join(root, "missing.json"))).toThrow(
      RunnerToolInvariantError,
    );
  });
});

test("the CLI accepts only an explicit valid profile option", () => {
  withFixture(
    {
      jobs: {
        check: {
          "runs-on": ["self-hosted", "example-provisioned"],
          steps: [{ run: "jq --version" }],
        },
      },
      files: { ...nativeToolchainFiles, "invalid.json": "{" },
    },
    (root) => {
      const cli = (...options: string[]) =>
        Bun.spawnSync([
          process.execPath,
          path.join(import.meta.dir, "check-ci-runner-tools.ts"),
          root,
          "example/project",
          ...options,
        ]);
      expect(cli("--profile", "runner-profile.json").exitCode).toBe(0);
      for (const options of [
        [],
        ["--profile"],
        ["--wrong", "runner-profile.json"],
        ["--profile", "missing.json"],
        ["--profile", "invalid.json"],
        ["--profile", "runner-profile.json", "extra"],
      ]) {
        expect(cli(...options).exitCode, options.join(" ")).not.toBe(0);
      }
    },
  );
});

const nativeJob = (steps: unknown[]) => ({
  "runs-on": ["self-hosted", "example-runner"],
  steps,
});

for (const operator of ["==", "!="]) {
  for (const firstRunner of [
    "'custom'",
    `fromJSON('["self-hosted","custom"]')`,
  ]) {
    for (const fallbackRunner of [
      "'ubuntu-24.04'",
      `fromJSON('["self-hosted","example-provisioned"]')`,
    ]) {
      test(`event-selected runner expression supports ${operator}, ${firstRunner}, ${fallbackRunner}`, () => {
        const condition = `github.event_name ${operator} 'schedule'`;
        const expression = `\${{ ${condition} && ${firstRunner} || ${fallbackRunner} }}`;
        for (const provision of [true, false]) {
          withFixture(
            {
              jobs: {
                check: {
                  "runs-on": expression,
                  steps: [
                    ...(provision
                      ? [{ if: condition, run: "brew install jq" }]
                      : []),
                    { run: "jq --version" },
                  ],
                },
              },
              files: nativeToolchainFiles,
            },
            (root) => {
              const findings = problems(root);
              expect(findings, expression).toHaveLength(provision ? 0 : 1);
              if (!provision) {
                expect(findings.at(0)).toContain("requires jq");
              }
            },
          );
        }
      });
    }
  }
}

test("unsupported runner expressions report the expression and fail closed", () => {
  for (const expression of [
    `\${{ github.event_name == 'schedule' && 'ubuntu-24.04' }}`,
    `\${{ github.event_name == 'schedule' && 'ubuntu-24.04' || 'ubuntu-24.04' || 'custom' }}`,
    `\${{ github.ref == 'main' && 'ubuntu-24.04' || 'ubuntu-24.04' }}`,
  ]) {
    withFixture(
      {
        jobs: {
          check: { "runs-on": expression, steps: [{ run: "jq --version" }] },
        },
      },
      (root) => {
        const findings = problems(root);
        expect(
          findings.some(
            (finding) =>
              /unsupported.*runs-on|runs-on.*unsupported/iu.test(finding) &&
              finding.includes(expression),
          ),
        ).toBe(true);
        expect(
          findings.some((finding) => finding.includes("requires jq")),
        ).toBe(true);
      },
    );
  }
});

test("native runner profiles declare the toolchain without guaranteeing its PATH", () => {
  withFixture({ jobs: {}, files: nativeToolchainFiles }, (root) => {
    const profile = fixtureProfiles(root).get("example-runner");
    expect(profile?.tools.size).toBe(0);
    expect(profile?.toolchain?.directory).toBe(nativeToolchainDirectory);
    expect([...(profile?.toolchain?.tools ?? [])]).toEqual(["jq"]);
    expect(
      runnerTools(
        ["self-hosted", "example-runner"],
        undefined,
        fixtureProfiles(root),
      ).size,
    ).toBe(0);
  });
});

for (const preflight of [
  `echo "${nativeToolchainDirectory}" >> "$GITHUB_PATH"`,
  `toolchain=${nativeToolchainDirectory}\necho "$toolchain" >> "$GITHUB_PATH"`,
  `toolchain="${nativeToolchainDirectory}"\necho "\${toolchain}" >> "\${GITHUB_PATH}"`,
]) {
  test(`declared native toolchain PATH takes effect only in later steps: ${preflight}`, () => {
    withFixture(
      {
        jobs: {
          check: nativeJob([
            { name: "Before preflight", run: "jq --version" },
            { name: "Preflight invocation", run: `${preflight}\njq --version` },
            { name: "After preflight", run: "jq --version" },
          ]),
          separate: nativeJob([{ name: "Separate job", run: "jq --version" }]),
        },
        files: nativeToolchainFiles,
      },
      (root) => {
        const findings = problems(root);
        expect(findings).toHaveLength(3);
        expect(
          findings.some((finding) => finding.includes("Before preflight")),
        ).toBe(true);
        expect(
          findings.some((finding) => finding.includes("Preflight invocation")),
        ).toBe(true);
        expect(
          findings.some((finding) => finding.includes("Separate job")),
        ).toBe(true);
      },
    );
  });
}

test("native toolchain PATH credits only declared tools and directories", () => {
  withFixture(
    {
      jobs: {
        declared: nativeJob([
          { run: `echo "${nativeToolchainDirectory}" >> "$GITHUB_PATH"` },
          { run: "jq --version\nrg --version" },
        ]),
        undeclared: nativeJob([
          { run: 'toolchain=/tmp/tools\necho "$toolchain" >> "$GITHUB_PATH"' },
          { run: "jq --version" },
        ]),
        container: {
          ...nativeJob([
            { run: `echo "${nativeToolchainDirectory}" >> "$GITHUB_PATH"` },
            { run: "jq --version" },
          ]),
          container: { image: "ubuntu:24.04" },
        },
      },
      files: nativeToolchainFiles,
    },
    (root) => {
      const findings = problems(root);
      expect(findings).toHaveLength(3);
      expect(
        findings.some(
          (finding) =>
            finding.includes("/declared/") && finding.includes("requires rg"),
        ),
      ).toBe(true);
      expect(
        findings.some(
          (finding) =>
            finding.includes("/undeclared/") && finding.includes("requires jq"),
        ),
      ).toBe(true);
      expect(
        findings.some(
          (finding) =>
            finding.includes("/container/") && finding.includes("requires jq"),
        ),
      ).toBe(true);
    },
  );
});

test("removing native PATH preflight restores the missing jq finding", () => {
  for (const preflight of [true, false]) {
    withFixture(
      {
        jobs: {
          check: {
            "runs-on": `\${{ github.event_name != 'pull_request' && fromJSON('["self-hosted","example-provisioned"]') || fromJSON('["self-hosted","example-runner"]') }}`,
            steps: [
              ...(preflight
                ? [
                    {
                      run: `toolchain=${nativeToolchainDirectory}\necho "$toolchain" >> "$GITHUB_PATH"`,
                    },
                  ]
                : []),
              { run: "jq --version" },
            ],
          },
        },
        files: nativeToolchainFiles,
      },
      (root) => {
        const findings = problems(root);
        expect(findings).toHaveLength(preflight ? 0 : 1);
        if (!preflight) {
          expect(findings.at(0)).toContain("requires jq");
        }
      },
    );
  }
});

test("a profile without a toolchain cannot credit a PATH append", () => {
  withFixture(
    {
      jobs: {
        check: nativeJob([
          { run: `echo "${nativeToolchainDirectory}" >> "$GITHUB_PATH"` },
          { run: "jq --version" },
        ]),
      },
      files: {
        "runner-profile.json": profileSource([
          { label: "example-runner", tools: [] },
        ]),
      },
    },
    (root) => {
      expect(
        fixtureProfiles(root).get("example-runner")?.toolchain,
      ).toBeUndefined();
      expect(problems(root)).toHaveLength(1);
    },
  );
});

test("native toolchain PATH follows the explicitly supplied profile directory", () => {
  const directory = path.join(tmpdir(), "example-other-tools", "bin");
  withFixture(
    {
      jobs: {
        check: nativeJob([
          { run: `echo "${directory}" >> "$GITHUB_PATH"` },
          { run: "jq --version" },
        ]),
      },
      files: {
        "runner-profile.json": profileSource([
          {
            label: "example-runner",
            tools: [],
            toolchain: { directory, tools: ["jq"] },
          },
        ]),
      },
    },
    (root) => {
      expect(
        fixtureProfiles(root).get("example-runner")?.toolchain?.directory,
      ).toBe(directory);
      expect(problems(root)).toEqual([]);
    },
  );
});

for (const [name, preflight] of Object.entries({
  conditional: `if [ -n "$OPTIONAL" ]; then\n  echo "${nativeToolchainDirectory}" >> "$GITHUB_PATH"\nfi`,
  loop: `for directory in ${nativeToolchainDirectory}; do\n  echo "$directory" >> "$GITHUB_PATH"\ndone`,
  "literal variable": `toolchain=${nativeToolchainDirectory}\necho '$toolchain' >> "$GITHUB_PATH"`,
  "shadowed destination": `GITHUB_PATH=/tmp/not-runner-path\necho "${nativeToolchainDirectory}" >> "$GITHUB_PATH"`,
  "unset destination": `unset GITHUB_PATH\necho "${nativeToolchainDirectory}" >> "$GITHUB_PATH"`,
  "unset directory": `toolchain=${nativeToolchainDirectory}\nunset toolchain\necho "$toolchain" >> "$GITHUB_PATH"`,
  "reassigned directory": `toolchain=${nativeToolchainDirectory}\ntoolchain=/tmp/tools\necho "$toolchain" >> "$GITHUB_PATH"`,
  "dynamic directory": `toolchain=${nativeToolchainDirectory}\ntoolchain=$(pwd)\necho "$toolchain" >> "$GITHUB_PATH"`,
  heredoc: `cat <<'END'\necho "${nativeToolchainDirectory}" >> "$GITHUB_PATH"\nEND`,
  "optional failure": `echo "${nativeToolchainDirectory}" >> "$GITHUB_PATH" || true`,
})) {
  test(`native PATH preflight denies ${name}`, () => {
    withFixture(
      {
        jobs: {
          check: nativeJob([{ run: preflight }, { run: "jq --version" }]),
        },
        files: nativeToolchainFiles,
      },
      (root) => {
        const findings = problems(root);
        expect(findings, preflight).toHaveLength(1);
        expect(findings.at(0)).toContain("requires jq");
      },
    );
  });
}

test("an optional preflight step cannot guarantee native PATH", () => {
  for (const optional of [
    { if: "github.event_name == 'schedule'" },
    { "continue-on-error": true },
  ]) {
    withFixture(
      {
        jobs: {
          check: nativeJob([
            {
              ...optional,
              run: `echo "${nativeToolchainDirectory}" >> "$GITHUB_PATH"`,
            },
            { run: "jq --version" },
          ]),
        },
        files: nativeToolchainFiles,
      },
      (root) => {
        expect(problems(root), JSON.stringify(optional)).toHaveLength(1);
      },
    );
  }
});

test("native preflight can inspect absolute declared tools before appending PATH", () => {
  const preflight = [
    `toolchain=${nativeToolchainDirectory}`,
    'test -x "$toolchain/jq"',
    'test -x "$toolchain/terraform"',
    'test -x "$toolchain/aws"',
    "command -v jq",
    '"$toolchain/jq" --version',
    'echo "$toolchain" >> "$GITHUB_PATH"',
  ].join("\n");
  withFixture(
    {
      jobs: {
        check: nativeJob([
          { name: "Preflight", run: preflight },
          { name: "After preflight", run: "jq --version" },
        ]),
        same_step: nativeJob([
          {
            name: "Same step bare invocation",
            run: `${preflight}\njq --version`,
          },
        ]),
        undeclared: nativeJob([
          {
            run: `toolchain=${nativeToolchainDirectory}\n"$toolchain/rg" --version`,
          },
        ]),
      },
      files: nativeToolchainFiles,
    },
    (root) => {
      const findings = problems(root);
      expect(findings).toHaveLength(2);
      expect(
        findings.some(
          (finding) =>
            finding.includes("Same step bare invocation") &&
            finding.includes("requires jq"),
        ),
      ).toBe(true);
      expect(
        findings.some(
          (finding) =>
            finding.includes("/undeclared/") && finding.includes("requires rg"),
        ),
      ).toBe(true);
    },
  );
});

for (const modification of [
  ': > "$GITHUB_PATH"',
  'echo replacement > "$GITHUB_PATH"',
  `echo replacement > "\${GITHUB_PATH}"`,
  'printf replacement | tee "$GITHUB_PATH"',
  'rm "$GITHUB_PATH"',
  "GITHUB_PATH=/tmp/other-path",
  "export GITHUB_PATH=/tmp/other-path",
  "unset GITHUB_PATH",
  'path_file="$GITHUB_PATH"\n: > "$path_file"',
  'echo /tmp/other-tools >> "$GITHUB_PATH"',
  'echo "unterminated',
]) {
  test(`native PATH credit scans the whole step before accepting: ${modification}`, () => {
    for (const position of ["before", "after"]) {
      const append = `echo "${nativeToolchainDirectory}" >> "$GITHUB_PATH"`;
      const lines =
        position === "before" ? [modification, append] : [append, modification];
      withFixture(
        {
          jobs: {
            check: nativeJob([
              { run: lines.join("\n") },
              { run: "jq --version" },
            ]),
          },
          files: nativeToolchainFiles,
        },
        (root) => {
          expect(
            problems(root).some((finding) => finding.includes("requires jq")),
            lines.join("\n"),
          ).toBe(true);
        },
      );
    }
  });
}

test("native PATH credit accepts only declared appends throughout the step", () => {
  withFixture(
    {
      jobs: {
        check: nativeJob([
          {
            run: `toolchain=${nativeToolchainDirectory}\necho "$toolchain" >> "$GITHUB_PATH"\necho "${nativeToolchainDirectory}" >> "$GITHUB_PATH"`,
          },
          { run: "jq --version" },
        ]),
      },
      files: nativeToolchainFiles,
    },
    (root) => expect(problems(root)).toEqual([]),
  );
});

for (const statement of [
  `toolchain=${nativeToolchainDirectory} true`,
  `echo toolchain=${nativeToolchainDirectory}`,
  `export toolchain=${nativeToolchainDirectory} OTHER=value`,
  `if true; then\n  toolchain=${nativeToolchainDirectory}\nfi`,
  `(toolchain=${nativeToolchainDirectory})`,
  `toolchain=${nativeToolchainDirectory} | cat`,
  `toolchain=${nativeToolchainDirectory}; true`,
  `true |\ntoolchain=${nativeToolchainDirectory}`,
  `false &&\ntoolchain=${nativeToolchainDirectory}`,
  `true ||\ntoolchain=${nativeToolchainDirectory}`,
  `function prepare {\n  toolchain=${nativeToolchainDirectory}\n}`,
  `toolchain=${nativeToolchainDirectory}\nbuiltin unset toolchain`,
  `toolchain=${nativeToolchainDirectory}\ncommand eval true`,
  `toolchain=${nativeToolchainDirectory}\nprintf -v toolchain /tmp/tools`,
  `toolchain=${nativeToolchainDirectory}\nmapfile toolchain < /tmp/tools`,
]) {
  test(`native exemptions reject assignment outside a standalone statement: ${statement}`, () => {
    withFixture(
      {
        jobs: {
          explicit: nativeJob([
            { run: `${statement}\n"$toolchain/jq" --version` },
          ]),
          path: nativeJob([
            { run: `${statement}\necho "$toolchain" >> "$GITHUB_PATH"` },
            { run: "jq --version" },
          ]),
        },
        files: nativeToolchainFiles,
      },
      (root) => {
        const findings = problems(root);
        expect(
          findings.some(
            (finding) =>
              finding.includes("/explicit/") && finding.includes("requires jq"),
          ),
        ).toBe(true);
        expect(
          findings.some(
            (finding) =>
              finding.includes("/path/") && finding.includes("requires jq"),
          ),
        ).toBe(true);
      },
    );
  });
}

for (const mutation of [
  "eval true",
  "source /tmp/tools.sh",
  ". /tmp/tools.sh",
]) {
  test(`native variable contract rejects opaque shell mutation: ${mutation}`, () => {
    withFixture(
      {
        jobs: {
          check: nativeJob([
            {
              run: `toolchain=${nativeToolchainDirectory}\n${mutation}\necho "$toolchain" >> "$GITHUB_PATH"`,
            },
            { run: "jq --version" },
          ]),
        },
        files: nativeToolchainFiles,
      },
      (root) =>
        expect(
          problems(root).some((finding) => finding.includes("requires jq")),
        ).toBe(true),
    );
  });
}

for (const literal of [
  nativeToolchainDirectory,
  `"${nativeToolchainDirectory}"`,
  `'${nativeToolchainDirectory}'`,
]) {
  test(`native exemptions accept a standalone literal statement: ${literal}`, () => {
    withFixture(
      {
        jobs: {
          check: nativeJob([
            {
              run: `toolchain=${literal}\n"$toolchain/jq" --version\necho "$toolchain" >> "$GITHUB_PATH"`,
            },
            { run: "jq --version" },
          ]),
        },
        files: nativeToolchainFiles,
      },
      (root) => expect(problems(root)).toEqual([]),
    );
  });
}

for (const statement of [
  "exit 0",
  "exit 1",
  "return 0",
  "exec true",
  "trap ':' EXIT",
  "set +e",
  "set -euo pipefail",
  "true",
  "echo ignored",
  "jq input.json",
  'test -x "$toolchain/jq" || exit 1',
  "if true; then\n  command -v jq\nfi",
  'for tool in jq; do\n  test -x "$toolchain/$tool"\ndone',
]) {
  test(`native PATH preflight rejects statements outside the straight-line allowlist: ${statement}`, () => {
    for (const position of ["before", "after"]) {
      const assignment = `toolchain=${nativeToolchainDirectory}`;
      const append = 'echo "$toolchain" >> "$GITHUB_PATH"';
      const script =
        position === "before"
          ? [assignment, statement, append]
          : [assignment, append, statement];
      withFixture(
        {
          jobs: {
            check: nativeJob([
              { run: script.join("\n") },
              { run: "jq --version" },
            ]),
          },
          files: nativeToolchainFiles,
        },
        (root) =>
          expect(
            problems(root).some((finding) => finding.includes("requires jq")),
          ).toBe(true),
      );
    }
  });
}
