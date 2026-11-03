import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

/**
 * The desktop release skips a build when nothing it ships changed, judged by
 * `rebuild_paths` in `scripts/detect-desktop-release-changes.sh`. The sidecar
 * bundles workspace code from outside `apps/desktop`, so every workspace file
 * it bundles must fall under one of those paths, or a sidecar change would
 * never reach users.
 */

const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..");
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
