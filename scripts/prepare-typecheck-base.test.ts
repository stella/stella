import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.resolve(import.meta.dir, "prepare-typecheck-base.sh");
const sha = "a".repeat(40);

test("base recordings require the exact main SHA and authoritative successful workflow", () => {
  const root = mkdtempSync(path.join(tmpdir(), "typecheck-recording-"));
  try {
    const bin = path.join(root, "bin");
    const data = path.join(root, "data");
    mkdirSync(bin);
    mkdirSync(data);
    for (const [name, content] of Object.entries({
      sha,
      "typecheck-base.json": "{}",
      "api-routes.gen.ts": "api",
      "routeTree.gen.ts": "routes",
    })) {
      writeFileSync(path.join(data, name), content);
    }
    const zip = path.join(root, "recording.zip");
    expect(
      Bun.spawnSync(
        [
          "zip",
          "-q",
          zip,
          "sha",
          "typecheck-base.json",
          "api-routes.gen.ts",
          "routeTree.gen.ts",
        ],
        { cwd: data },
      ).exitCode,
    ).toBe(0);
    const stubs = {
      git: `#!/bin/bash\nif [[ "$1" == merge-base ]]; then printf '%s' "$TEST_SHA"; else exit 77; fi\n`,
      gh: `#!/bin/bash\ncase "$2" in\n */actions/artifacts/1/zip) cat "$TEST_ZIP" ;;\n */actions/runs/2) printf '%s' "$TEST_RUN" ;;\n *) printf '%s' "$TEST_ARTIFACTS" ;;\nesac\n`,
    };
    for (const [name, source] of Object.entries(stubs)) {
      const file = path.join(bin, name);
      writeFileSync(file, source);
      chmodSync(file, 0o755);
    }
    const run = {
      path: ".github/workflows/typecheck-base.yml",
      event: "push",
      conclusion: "success",
      head_branch: "main",
      head_sha: sha,
    };
    for (const [label, candidate, accepted] of [
      ["main", run, true],
      ["PR", { ...run, event: "pull_request" }, false],
      ["other workflow", { ...run, path: ".github/workflows/ci.yml" }, false],
      ["wrong SHA", { ...run, head_sha: "b".repeat(40) }, false],
      ["failed", { ...run, conclusion: "failure" }, false],
      ["feature branch", { ...run, head_branch: "feature" }, false],
    ] as const) {
      const runner = path.join(root, label.replaceAll(" ", "-"));
      mkdirSync(runner);
      const summary = path.join(runner, "summary");
      const result = Bun.spawnSync(["bash", script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          RUNNER_TEMP: runner,
          GITHUB_STEP_SUMMARY: summary,
          REPOSITORY: "example/repo",
          TEST_SHA: sha,
          TEST_ZIP: zip,
          TEST_RUN: JSON.stringify(candidate),
          TEST_ARTIFACTS: JSON.stringify({
            artifacts: [
              {
                id: 1,
                name: `typecheck-base-v1-${sha}`,
                expired: false,
                workflow_run: { id: 2 },
              },
            ],
          }),
        },
      });
      expect(result.exitCode, label).toBe(accepted ? 0 : 77);
      if (accepted) {
        expect(
          readFileSync(
            path.join(
              runner,
              "typecheck-base/apps/web/src/generated/api-routes.gen.ts",
            ),
            "utf-8",
          ),
        ).toBe("api");
        expect(
          readFileSync(path.join(runner, "typecheck-base.json"), "utf-8"),
        ).toBe("{}");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type FallbackOptions = {
  failure:
    | "none"
    | "lookup"
    | "metadata"
    | "download"
    | "invalid-response"
    | "invalid-archive";
  source?: string;
  measurementExit?: number;
};

const runFallback = ({
  failure,
  source,
  measurementExit = 0,
}: FallbackOptions) => {
  const root = mkdtempSync(path.join(tmpdir(), "typecheck-base-prepared-"));
  try {
    const bin = path.join(root, "bin");
    const base = path.join(root, "typecheck-base");
    mkdirSync(bin);
    mkdirSync(path.join(base, "scripts"), { recursive: true });
    mkdirSync(path.join(base, "apps/api/scripts"), { recursive: true });
    writeFileSync(
      path.join(base, "apps/api/scripts/generate-capability-runtime.ts"),
      "",
    );
    writeFileSync(
      path.join(base, "scripts/retry.sh"),
      '#!/bin/bash\nexec "$@"\n',
    );
    for (const [name, stub] of Object.entries({
      git: '#!/bin/bash\nif [[ "$1" == merge-base ]]; then printf "%s" "$TEST_SHA"; else printf "git:%s\\n" "$*" >> "$TEST_COMMANDS"; fi\n',
      gh: `#!/bin/bash
case "$*" in
 *actions/runs/2*) stage=metadata; response="$TEST_RUN" ;;
 *actions/artifacts/1/zip*) stage=download; response=invalid-zip ;;
 *) stage=lookup; response="$TEST_ARTIFACTS" ;;
esac
if [[ "$TEST_FAILURE" == "$stage" ]]; then echo 'gh: HTTP 503' >&2; exit 23; fi
if [[ "$TEST_FAILURE" == invalid-response && "$stage" == lookup ]]; then response=invalid-json; fi
printf '%s' "$response"
`,
      bun: `#!/bin/bash\nif [[ "$PWD" == "$RUNNER_TEMP/typecheck-base" ]]; then [[ -z "\${CI_GENERATED_SOURCES_MANIFEST+x}" ]] || exit 61; else [[ "$CI_GENERATED_SOURCES_MANIFEST" == "$TEST_HEAD_MANIFEST" ]] || exit 62; fi\nprintf "%s:%s\\n" "$PWD" "$*" >> "$TEST_COMMANDS"\nif [[ "$1" == scripts/typecheck-baseline.ts ]]; then exit "$TEST_MEASUREMENT_EXIT"; fi\n`,
    })) {
      const file = path.join(bin, name);
      writeFileSync(file, stub);
      chmodSync(file, 0o755);
    }
    const commands = path.join(root, "commands");
    const headManifest = path.join(
      root,
      "head/.cache/ci-generated-sources/manifest.json",
    );
    const target = path.join(root, "prepare.sh");
    writeFileSync(target, source ?? readFileSync(script, "utf-8"));
    const result = Bun.spawnSync(["bash", target], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        RUNNER_TEMP: root,
        REPOSITORY: "example/repo",
        TEST_SHA: sha,
        TEST_FAILURE: failure,
        TEST_MEASUREMENT_EXIT: String(measurementExit),
        TEST_RUN: JSON.stringify({
          path: ".github/workflows/typecheck-base.yml",
          event: "push",
          conclusion: "success",
          head_branch: "main",
          head_sha: sha,
        }),
        TEST_ARTIFACTS: JSON.stringify({
          artifacts:
            failure === "none"
              ? []
              : [
                  {
                    id: 1,
                    name: `typecheck-base-v1-${sha}`,
                    expired: false,
                    workflow_run: { id: 2 },
                  },
                ],
        }),
        TEST_HEAD_MANIFEST: headManifest,
        CI_GENERATED_SOURCES_MANIFEST: headManifest,
        TEST_COMMANDS: commands,
        GITHUB_STEP_SUMMARY: path.join(root, "summary"),
      },
    });
    return {
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      commands:
        Bun.file(commands).size === 0 ? "" : readFileSync(commands, "utf-8"),
      summary:
        Bun.file(path.join(root, "summary")).size === 0
          ? ""
          : readFileSync(path.join(root, "summary"), "utf-8"),
      base,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

for (const failure of [
  "none",
  "lookup",
  "metadata",
  "download",
  "invalid-response",
  "invalid-archive",
] as const) {
  test(`unavailable recording (${failure}) measures the exact base with isolated generated sources`, () => {
    const result = runFallback({ failure });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.commands).toContain(
      `git:worktree add --detach ${result.base} ${sha}`,
    );
    expect(result.commands).toContain(
      `${result.base}:--filter @stll/api generate:capability-runtime`,
    );
    expect(result.commands).toContain(`${result.base}:run generate`);
    expect(result.commands).toContain(
      `${result.base}:--filter @stll/web generate:route-tree`,
    );
    expect(result.commands).toContain(
      `:scripts/typecheck-baseline.ts --measure ${result.base}`,
    );
    expect(result.summary).toContain(`recording unavailable; measuring ${sha}`);
    if (failure !== "none") {
      expect(result.stderr).toContain("::warning::Typecheck baseline:");
    }
    if (["lookup", "metadata", "download"].includes(failure)) {
      expect(result.stderr).toContain("gh: HTTP 503");
    }
  });
}

test("failed exact-base measurement remains fatal after an unavailable recording", () => {
  const result = runFallback({ failure: "lookup", measurementExit: 83 });
  expect(result.exitCode).toBe(83);
  expect(result.commands).toContain(
    `:scripts/typecheck-baseline.ts --measure ${result.base}`,
  );
});

test("restoring a fatal recording lookup prevents the required exact-base fallback", () => {
  const source = readFileSync(script, "utf-8");
  const fatal = source.replace(
    /if ! artifacts=([^\n]+); then\n[\s\S]*?\nfi/u,
    "artifacts=$1",
  );
  expect(fatal).not.toBe(source);
  const result = runFallback({ failure: "lookup", source: fatal });
  expect(result.exitCode).toBe(23);
  expect(result.stderr).toContain("gh: HTTP 503");
  expect(result.commands).toBe("");
});
