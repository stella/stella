import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { sidecarDefines } from "./sidecar-defines";

/**
 * The desktop release skips a build when nothing it ships changed, judged by
 * `rebuild_paths` in `scripts/detect-desktop-release-changes.sh`. The sidecar
 * bundles workspace code from outside `apps/desktop`, so every workspace file
 * it bundles must fall under one of those paths, or a sidecar change would
 * never reach users.
 */

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const DETECTOR = path.join(
  REPO_ROOT,
  "scripts/detect-desktop-release-changes.sh",
);

const rebuildPaths = () => {
  const script = readFileSync(DETECTOR, "utf-8");
  const block = /^rebuild_paths=\(\n(?<body>[\s\S]*?)^\)/mu.exec(script)
    ?.groups?.["body"];
  return (block ?? "")
    .split("\n")
    .map((line) => /^\s*"(?<entry>[^"]+)"\s*$/u.exec(line)?.groups?.["entry"])
    .filter((entry) => entry !== undefined);
};

const MetafileSchema = v.object({ inputs: v.record(v.string(), v.unknown()) });

/**
 * A program that prints the stella browser's switch and test hooks as the
 * environment sets them, bundled as the sidecar is (minified, with the
 * given defines), and run with the switch on and every hook set: what a
 * build does with them, not what its source says.
 */
const hooksSeenBy = async (define: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), "stella-sidecar-defines-"));
  try {
    const entry = path.join(dir, "entry.ts");
    writeFileSync(
      entry,
      `import { stellaBrowserDevHost, stellaBrowserTestHooks } from ${JSON.stringify(path.join(PACKAGE_DIR, "src/sidecar/env.ts"))};\nconsole.log(JSON.stringify({ devHost: stellaBrowserDevHost(), hooks: stellaBrowserTestHooks() }));\n`,
    );
    const built = await Bun.build({
      define,
      entrypoints: [entry],
      minify: true,
      outdir: path.join(dir, "out"),
      target: "bun",
    });
    expect(built.success).toBe(true);
    const output = built.outputs.at(0)?.path ?? "";
    const ran = Bun.spawnSync([process.execPath, output], {
      env: {
        PATH: process.env["PATH"] ?? "",
        STELLA_BROWSER_DEV_HOST: "1",
        STELLA_BROWSER_TEST_EXECUTABLE: "/opt/browser/browser",
        STELLA_BROWSER_TEST_HOOKS: "1",
        STELLA_BROWSER_TEST_HOST_RULES: "MAP * 127.0.0.1",
        STELLA_BROWSER_TEST_SPKI: "c3BraQ==",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    return {
      code: readFileSync(output, "utf-8"),
      printed: ran.stdout.toString().trim(),
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

describe("the stella browser's switch and test hooks", () => {
  test("are dead code in a release build, whatever the environment sets", async () => {
    const release = await hooksSeenBy(sidecarDefines("1.0.0"));
    expect(JSON.parse(release.printed)).toEqual({
      devHost: false,
      hooks: null,
    });
    expect(release.code).not.toContain("ignore-certificate-errors-spki-list");
    expect(release.code).not.toContain("host-resolver-rules");
  });

  test("are read where the build keeps them, so the release check can fail", async () => {
    const kept = await hooksSeenBy({});
    expect(JSON.parse(kept.printed)).toMatchObject({
      devHost: true,
      hooks: { executable: "/opt/browser/browser" },
    });
  });
});

describe("the bundled harness sidecar", () => {
  test("only bundles workspace files a desktop release rebuilds for", async () => {
    const built = await Bun.build({
      entrypoints: [path.join(PACKAGE_DIR, "src/sidecar/main.ts")],
      target: "bun",
      metafile: true,
    });
    expect(built.success).toBe(true);
    const metafile: unknown =
      typeof built.metafile === "string"
        ? JSON.parse(built.metafile)
        : built.metafile;
    const workspaceInputs = Object.keys(
      v.parse(MetafileSchema, metafile).inputs,
    )
      .filter((input) => !input.split(/[\\/]/u).includes("node_modules"))
      .map((input) => {
        const absolute = path.resolve(process.cwd(), input);
        // Outside the repository stays absolute, so no rebuild path covers it.
        return absolute.startsWith(`${REPO_ROOT}${path.sep}`)
          ? absolute
              .slice(REPO_ROOT.length + 1)
              .split(path.sep)
              .join("/")
          : absolute;
      });
    const covered = rebuildPaths();
    expect(covered).toContain("packages/agent-engine/");
    expect(workspaceInputs.length).toBeGreaterThan(0);
    expect(
      workspaceInputs.filter(
        (input) =>
          !covered.some(
            (entry) =>
              input === entry ||
              (entry.endsWith("/") && input.startsWith(entry)),
          ),
      ),
    ).toEqual([]);
  });
});
