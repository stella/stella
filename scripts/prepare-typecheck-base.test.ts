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

test("base fallback generates in its own checkout while head measurement retains its manifest", () => {
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
    for (const [name, source] of Object.entries({
      git: '#!/bin/bash\nif [[ "$1" == merge-base ]]; then printf "%s" "$TEST_SHA"; fi\n',
      gh: `#!/bin/bash\nprintf '%s' '{"artifacts":[]}'\n`,
      bun: `#!/bin/bash\nif [[ "$PWD" == "$RUNNER_TEMP/typecheck-base" ]]; then [[ -z "\${CI_GENERATED_SOURCES_MANIFEST+x}" ]] || exit 61; else [[ "$CI_GENERATED_SOURCES_MANIFEST" == "$TEST_HEAD_MANIFEST" ]] || exit 62; fi\nprintf "%s:%s\\n" "$PWD" "$*" >> "$TEST_COMMANDS"\n`,
    })) {
      const file = path.join(bin, name);
      writeFileSync(file, source);
      chmodSync(file, 0o755);
    }
    const commands = path.join(root, "commands");
    const headManifest = path.join(
      root,
      "head/.cache/ci-generated-sources/manifest.json",
    );
    const result = Bun.spawnSync(["bash", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        RUNNER_TEMP: root,
        REPOSITORY: "example/repo",
        TEST_SHA: sha,
        TEST_HEAD_MANIFEST: headManifest,
        CI_GENERATED_SOURCES_MANIFEST: headManifest,
        TEST_COMMANDS: commands,
        GITHUB_STEP_SUMMARY: path.join(root, "summary"),
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const actual = readFileSync(commands, "utf-8");
    expect(actual).toContain(
      `${base}:--filter @stll/api generate:capability-runtime`,
    );
    expect(actual).toContain(`${base}:run generate`);
    expect(actual).toContain(`${base}:--filter @stll/web generate:route-tree`);
    expect(actual).toContain(
      `:scripts/typecheck-baseline.ts --measure ${base}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
