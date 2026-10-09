import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  checkCompositeSource,
  checkWorkflowShells,
  checkWorkflowSource,
} from "./check-workflow-shells";

const root = path.resolve(import.meta.dir, "..");
const defaults = "defaults:\n  run:\n    shell: bash\n";
const expression = (value: string): string => ["${{ ", value, " }}"].join("");
const posixDefault = ["$", "{VALUE:-x}"].join("");

describe("workflow shell policy", () => {
  test("every current workflow and composite action passes", () => {
    expect(checkWorkflowShells(root)).toEqual([]);
  });

  test.each([
    ["literal Windows runner", "runs-on: windows-latest"],
    [
      "Windows matrix",
      `runs-on: ${expression("matrix.os")}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]`,
    ],
    [
      "fromJSON matrix",
      `runs-on: ${expression("matrix.os")}\n    strategy:\n      matrix: ${expression("fromJSON(needs.plan.outputs.matrix)")}`,
    ],
    ["runner group", "runs-on:\n      group: desktop"],
    ["self-hosted label", "runs-on: [self-hosted, desktop]"],
    ["workflow input", `runs-on: ${expression("inputs.os")}`],
  ])("detects a missing shell default for %s", (_name, runner) => {
    const source = `name: fixture\non: push\njobs:\n  check:\n    ${runner}\n    steps:\n      - name: Copy\n        run: echo ok\n`;
    expect(checkWorkflowSource("fixture.yml", source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("Windows-capable"),
        }),
      ]),
    );
  });

  test.each([
    "[[ -f x ]]",
    "set -euo pipefail",
    "cat <<< x",
    `echo ${posixDefault}`,
    "if true; then echo x; fi",
    "for x in a; do echo x; done",
    "FOO=bar command",
  ])("detects bash syntax under pwsh: %s", (run) => {
    const source = `name: fixture\n${defaults}on: push\njobs:\n  check:\n    runs-on: windows-latest\n    steps:\n      - name: Broken\n        shell: pwsh\n        run: |\n          ${run}\n`;
    expect(checkWorkflowSource("fixture.yml", source)).toEqual([
      expect.objectContaining({
        line: 10,
        message: expect.stringContaining("bash syntax"),
      }),
    ]);
  });

  test.each(["value=$(echo x)", "cp a b", "mkdir -p x"])(
    "detects bash command shapes under cmd: %s",
    (run) => {
      const source = `name: fixture\n${defaults}on: push\njobs:\n  check:\n    runs-on: windows-latest\n    steps:\n      - name: Broken\n        shell: cmd\n        run: |\n          ${run}\n`;
      expect(checkWorkflowSource("fixture.yml", source)).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("bash syntax"),
        }),
      ]);
    },
  );

  test.each([
    'Write-Host "$($repository.SourceLocation)"',
    'Write-Host "$([System.IO.Path]::GetTempPath())"',
    'Write-Host "$(Get-Date)"',
    "$repository = $(Get-PSRepository -Name PSGallery)",
    "cp a b",
    "mkdir -p x",
  ])("allows PowerShell subexpressions under pwsh: %s", (run) => {
    const source = `name: fixture\n${defaults}on: push\njobs:\n  check:\n    runs-on: windows-latest\n    steps:\n      - name: Valid\n        shell: pwsh\n        run: |\n          ${run}\n`;
    expect(checkWorkflowSource("fixture.yml", source)).toEqual([]);
  });

  test.each(["defaults:", "defaults: bash", "defaults:\n  run:"])(
    "rejects malformed defaults: %s",
    (invalidDefaults) => {
      const source = `name: fixture\n${invalidDefaults}\non: push\njobs: {}\n`;
      expect(checkWorkflowSource("fixture.yml", source)).toContainEqual(
        expect.objectContaining({
          message: "defaults and defaults.run must be mappings",
        }),
      );
    },
  );

  test("checks steps nested in parallel groups", () => {
    const source = `name: fixture\n${defaults}on: push\njobs:\n  check:\n    runs-on: windows-latest\n    steps:\n      - parallel:\n          - name: Nested\n            shell: pwsh\n            run: FOO=bar command\n`;
    expect(checkWorkflowSource("fixture.yml", source)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("bash syntax"),
      }),
    ]);
  });

  test.each(["bash -c {0}", "bash --noprofile {0}"])(
    "rejects custom workflow default shells: %s",
    (shell) => {
      const source = `name: fixture\ndefaults:\n  run:\n    shell: ${shell}\non: push\njobs: {}\n`;
      expect(checkWorkflowSource("fixture.yml", source)).toContainEqual(
        expect.objectContaining({
          message: "workflow must define defaults.run.shell: bash",
        }),
      );
    },
  );

  test("catches the historical release desktop copy step", () => {
    const run = `|\n          cp "$GITHUB_WORKSPACE/.gh-retry/scripts/gh-retry.sh" "$RUNNER_TEMP/gh-retry.sh"\n          echo "GH_RETRY_SCRIPT=$RUNNER_TEMP/gh-retry.sh" >> "$GITHUB_ENV"`;
    const source = `name: release\non: push\njobs:\n  build:\n    runs-on: windows-latest\n    steps:\n      - name: Preserve GitHub API tooling across source checkouts\n        run: |\n          ${run}\n`;
    const messages = checkWorkflowSource("release-desktop.yml", source).map(
      ({ message }) => message,
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Windows-capable"),
        expect.stringContaining("bash syntax"),
      ]),
    );
  });

  test("mutation removing a workflow default fails", () => {
    const current = readFileSync(
      path.join(root, ".github/workflows/release-desktop.yml"),
      "utf-8",
    );
    expect(current).toContain(defaults);
    expect(
      checkWorkflowSource("release-desktop.yml", current.replace(defaults, "")),
    ).toContainEqual(
      expect.objectContaining({
        message: "workflow must define defaults.run.shell: bash",
      }),
    );
  });

  test("composite actions require explicit shells", () => {
    const source =
      "name: fixture\nruns:\n  using: composite\n  steps:\n    - name: Copy\n      run: cp a b\n";
    expect(checkCompositeSource("action.yml", source)).toEqual([
      expect.objectContaining({
        line: 5,
        message: expect.stringContaining("declare shell"),
      }),
    ]);
  });

  test.each(["", '""'])(
    "composite actions reject empty shells: %s",
    (shell) => {
      const source = `name: fixture\nruns:\n  using: composite\n  steps:\n    - name: Copy\n      shell: ${shell}\n      run: cp a b\n`;
      expect(checkCompositeSource("action.yml", source)).toEqual([
        expect.objectContaining({
          line: 5,
          message: expect.stringContaining("declare shell"),
        }),
      ]);
    },
  );
});
