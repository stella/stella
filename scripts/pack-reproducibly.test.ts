import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test.each(["identical", "different"])(
  "%s rebuilds preserve the source manifest and enforce artifact equality",
  (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "publish-reproducibility-"));
    const manifest = path.join(root, "packages/fixture/package.json");
    const original = '{"shape":"source"}\n';
    mkdirSync(path.dirname(manifest), { recursive: true });
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "bin"));
    copyFileSync(
      path.join(import.meta.dirname, "pack-reproducibly.sh"),
      path.join(root, "scripts/pack-reproducibly.sh"),
    );
    writeFileSync(manifest, original);
    writeFileSync(
      path.join(root, "bin/bun"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == run ]]; then
  [[ "$(cat package.json)" == '{"shape":"source"}' ]]
  mkdir dist
  exit 0
fi
if [[ "$1" == */prepare-publish.ts ]]; then
  printf '{"shape":"published"}\\n' > "$2/package.json"
  exit 0
fi
[[ "$1" == pm && "$2" == pack && "$3" == --ignore-scripts && "$4" == --destination ]]
if [[ "$PACK_TEST_MODE" == different ]]; then
  printf '%s' "$5" > "$5/fixture.tgz"
else
  printf 'identical tarball bytes' > "$5/fixture.tgz"
fi
`,
      { mode: 0o755 },
    );
    try {
      const result = spawnSync(
        "bash",
        [
          path.join(root, "scripts/pack-reproducibly.sh"),
          "fixture",
          path.join(root, "artifacts"),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${path.join(root, "bin")}:${process.env["PATH"]}`,
            PACK_TEST_MODE: mode,
          },
          encoding: "utf-8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(mode === "identical" ? 0 : 1);
      expect(readFileSync(manifest, "utf-8")).toBe(original);
      if (mode === "different") {
        expect(result.stderr).toContain(
          "rebuilding the same source produced different npm tarball bytes",
        );
        expect(readdirSync(path.join(root, "artifacts"))).toEqual([]);
        return;
      }
      expect(existsSync(path.join(root, "artifacts/fixture.tgz"))).toBe(true);
      expect(result.stdout).toContain(
        "verified byte-identical rebuilt tarball",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
