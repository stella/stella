import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const workflow = v.parse(
  v.object({
    on: v.object({ pull_request: v.object({ paths: v.array(v.string()) }) }),
    jobs: v.object({
      preview: v.object({
        steps: v.array(
          v.object({ id: v.optional(v.string()), run: v.optional(v.string()) }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/visual-preview.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const source = v.parse(
  v.string(),
  workflow.jobs.preview.steps.find(({ id }) => id === "scope")?.run,
);

type ScopeOptions = {
  event: string;
  changedFiles: readonly string[];
  fetchStatus?: number;
  diffStatus?: number;
};

const runScope = ({
  event,
  changedFiles,
  fetchStatus = 0,
  diffStatus = 0,
}: ScopeOptions) => {
  const directory = mkdtempSync(path.join(tmpdir(), "visual-preview-scope-"));
  const bin = path.join(directory, "bin");
  const output = path.join(directory, "output");
  const calls = path.join(directory, "calls");
  const bash = Bun.which("bash") ?? panic("Scope tests require bash");
  mkdirSync(bin);
  symlinkSync(
    Bun.which("grep") ?? panic("Scope tests require grep"),
    path.join(bin, "grep"),
  );
  writeFileSync(output, "");
  writeFileSync(calls, "");
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  fetch) exit "$FETCH_STATUS" ;;
  diff) printf '%s\\n' "$CHANGED_FILES"; exit "$DIFF_STATUS" ;;
  *) exit 91 ;;
esac
`,
    { mode: 0o755 },
  );
  try {
    expect(Bun.which("rg", { PATH: bin })).toBeNull();
    const result = Bun.spawnSync([bash, "-e", "-c", source], {
      env: {
        PATH: bin,
        EVENT_NAME: event,
        BASE_SHA: "a".repeat(40),
        GITHUB_OUTPUT: output,
        CALL_LOG: calls,
        CHANGED_FILES: changedFiles.join("\n"),
        FETCH_STATUS: String(fetchStatus),
        DIFF_STATUS: String(diffStatus),
      },
    });
    return {
      exitCode: result.exitCode,
      output: readFileSync(output, "utf-8"),
      calls: readFileSync(calls, "utf-8"),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("preview scope runs without ripgrep across events and every declared input", () => {
  const relevant = workflow.on.pull_request.paths.map((input) =>
    input.endsWith("/**") ? input.replace(/\/\*\*$/u, "/fixture.ts") : input,
  );
  const cases = [
    ...relevant.map((input) => ({ changedFiles: [input], required: true })),
    { changedFiles: [], required: false },
    {
      changedFiles: ["docs/readme.md", "apps/web/src/main.tsx"],
      required: false,
    },
    {
      changedFiles: ["apps/visual-preview-other/file.ts", "bun.lock.backup"],
      required: false,
    },
    {
      changedFiles: [
        "docs/readme.md",
        "apps/visual-preview/file with spaces.ts",
      ],
      required: true,
    },
  ];
  for (const event of ["merge_group", "pull_request", "workflow_dispatch"]) {
    for (const { changedFiles, required } of cases) {
      const result = runScope({ event, changedFiles });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.output, `${event}: ${changedFiles.join(", ")}`).toBe(
        `required=${event !== "merge_group" || required}\n`,
      );
      if (event !== "merge_group") {
        expect(result.calls).toBe("");
      }
    }
  }
});

test("merge-group Git failures cannot publish a successful preview skip", () => {
  for (const changedFiles of [
    [],
    ["apps/visual-preview/fixture.ts"],
    ["docs/readme.md"],
  ]) {
    for (const failure of [{ fetchStatus: 17 }, { diffStatus: 19 }]) {
      const result = runScope({
        event: "merge_group",
        changedFiles,
        ...failure,
      });
      expect(result.exitCode).toBe(failure.fetchStatus ?? failure.diffStatus);
      expect(result.output).toBe("");
    }
  }
  for (const event of ["pull_request", "workflow_dispatch"]) {
    const result = runScope({
      event,
      changedFiles: [],
      fetchStatus: 17,
      diffStatus: 19,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("required=true\n");
    expect(result.calls).toBe("");
  }
});
