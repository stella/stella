import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dirname, "upload-release-assets.sh");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

const fixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "release-assets-"));
  directories.push(directory);
  await mkdir(path.join(directory, "remote"));
  const runner = path.join(directory, "gh-runner.sh");
  await writeFile(
    runner,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_ROOT/calls"
case "$2" in
  view)
    [[ "\${FAIL_VIEW:-}" != 1 ]] || exit 1
    for file in "$FAKE_ROOT"/remote/*; do
      [[ ! -f "$file" ]] || basename "$file"
    done
    ;;
  download)
    name=''
    output=''
    while (($# > 0)); do
      case "$1" in
        --pattern) name=$2; shift 2 ;;
        --dir) output=$2; shift 2 ;;
        --output) exit 97 ;;
        *) shift ;;
      esac
    done
    mkdir -p "$output"
    cp "$FAKE_ROOT/remote/$name" "$output/$name"
    ;;
  upload)
    for arg in "$@"; do [[ "$arg" != --clobber ]] || exit 99; done
    file=\${!#}
    target="$FAKE_ROOT/remote/$(basename "$file")"
    [[ ! -e "$target" ]] || exit 22
    cp "$file" "$target"
    [[ "\${LOSE_UPLOAD_RESPONSE:-}" != 1 ]] || exit 1
    ;;
  *) exit 98 ;;
esac
exit 0
`,
  );
  const file = path.join(directory, "stella-linux-x64");
  await writeFile(file, "signed executable");
  return { directory, runner, file };
};

test("an identical published asset is skipped without a write", async () => {
  const { directory, runner, file } = await fixture();
  await writeFile(
    path.join(directory, "remote/stella-linux-x64"),
    await readFile(file),
  );
  const result = Bun.spawnSync(["bash", SCRIPT, "owner/repo", "v1", file], {
    env: { ...process.env, GH_RETRY_SCRIPT: runner, FAKE_ROOT: directory },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(
    "Skipping identical published release asset",
  );
  expect(await readFile(path.join(directory, "calls"), "utf-8")).not.toContain(
    "release upload",
  );
});

test("a different published asset is refused without modifying it", async () => {
  const { directory, runner, file } = await fixture();
  const remote = path.join(directory, "remote/stella-linux-x64");
  await writeFile(remote, "previously published executable");
  const result = Bun.spawnSync(["bash", SCRIPT, "owner/repo", "v1", file], {
    env: { ...process.env, GH_RETRY_SCRIPT: runner, FAKE_ROOT: directory },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(
    "Refusing to replace published release asset stella-linux-x64: SHA-256 differs",
  );
  expect(await readFile(remote, "utf-8")).toBe(
    "previously published executable",
  );
  expect(await readFile(path.join(directory, "calls"), "utf-8")).not.toContain(
    "release upload",
  );
});

test("a missing asset is uploaded once and a replay skips it", async () => {
  const { directory, runner, file } = await fixture();
  for (let replay = 0; replay < 2; replay += 1) {
    const result = Bun.spawnSync(["bash", SCRIPT, "owner/repo", "v1", file], {
      env: { ...process.env, GH_RETRY_SCRIPT: runner, FAKE_ROOT: directory },
    });
    expect(result.exitCode).toBe(0);
  }
  expect(
    await readFile(path.join(directory, "remote/stella-linux-x64"), "utf-8"),
  ).toBe("signed executable");
  const calls = await readFile(path.join(directory, "calls"), "utf-8");
  expect(calls.match(/release upload/gu)).toHaveLength(1);
  expect(calls).not.toContain("--clobber");
});

test("a failed metadata read never becomes an upload", async () => {
  const { directory, runner, file } = await fixture();
  const result = Bun.spawnSync(["bash", SCRIPT, "owner/repo", "v1", file], {
    env: {
      ...process.env,
      GH_RETRY_SCRIPT: runner,
      FAKE_ROOT: directory,
      FAIL_VIEW: "1",
    },
  });
  expect(result.exitCode).toBe(1);
  expect(await readFile(path.join(directory, "calls"), "utf-8")).not.toContain(
    "release upload",
  );
});

test("an upload accepted before a lost response is reconciled without replacement", async () => {
  const { directory, runner, file } = await fixture();
  const result = Bun.spawnSync(["bash", SCRIPT, "owner/repo", "v1", file], {
    env: {
      ...process.env,
      GH_RETRY_SCRIPT: runner,
      FAKE_ROOT: directory,
      LOSE_UPLOAD_RESPONSE: "1",
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(
    "Skipping identical published release asset",
  );
  const calls = await readFile(path.join(directory, "calls"), "utf-8");
  expect(calls.match(/release upload/gu)).toHaveLength(1);
  expect(calls).not.toContain("--clobber");
});
