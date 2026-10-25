import { $ } from "bun";
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "download-run-artifact.sh");
// Dynamic reads inspect disposable artifact fixtures, never checkout Markdown.
export const CI_MARKDOWN_READER_INPUTS = [] as const;

// Short for fast tests, long enough for two shell starts on a busy host.
const BOUND_SECONDS = 2;

// Call N of the fake runs the fixture responses/N with $dir set to the
// directory the download was asked to write into.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -e "$FAKE_ROOT/count" ]] || count=$(cat "$FAKE_ROOT/count")
count=$((count + 1))
echo "$count" > "$FAKE_ROOT/count"
printf '%s\\n' "$*" >> "$FAKE_ROOT/calls"
dir=''
while (($# > 0)); do
  case "$1" in
    --dir) dir=$2; shift 2 ;;
    *) shift ;;
  esac
done
[[ -z "$dir" ]] || mkdir -p "$dir"
source "$FAKE_ROOT/responses/$count"
`;

// GNU timeout is not part of every developer host. This stand-in keeps its
// contract for the script: the command's whole process group is stopped at
// the bound and the exit status is 124.
const TIMEOUT_STAND_IN = `#!/usr/bin/env bash
set -u
grace=1
while (($# > 0)); do
  case "$1" in
    --kill-after=*) grace=$(echo "$1" | cut -d= -f2); shift ;;
    -k|--kill-after) grace=$2; shift 2 ;;
    --) shift; break ;;
    -*) echo "timeout stand-in: unsupported option $1" >&2; exit 125 ;;
    *) break ;;
  esac
done
seconds=$1
shift
marker=$(mktemp -d)
set -m
"$@" &
command_pid=$!
(
  sleep "$seconds"
  : > "$marker/expired"
  kill -TERM -- "-$command_pid" 2>/dev/null
  sleep "$grace"
  kill -KILL -- "-$command_pid" 2>/dev/null
) >/dev/null 2>&1 &
watcher_pid=$!
wait "$command_pid"
status=$?
kill -KILL -- "-$watcher_pid" 2>/dev/null
wait "$watcher_pid" 2>/dev/null
if [[ -e "$marker/expired" ]]; then status=124; fi
rm -rf "$marker"
exit "$status"
`;

const HANG = `[[ -z "$dir" ]] || echo partial > "$dir/partial.txt"
exec sleep 20
`;
// The artifact listing a pattern download reads first.
const list = (...names: string[]) =>
  names.map((name) => `printf '%s\\n' ${$.escape(name)}\n`).join("");
const fail = (message: string, status: number) =>
  `printf '%s\\n' ${$.escape("private trace line")} ${$.escape(`gh: ${message} (HTTP ${String(status)})`)} >&2
exit 1
`;
const write = (files: Record<string, string>) =>
  Object.entries(files)
    .map(
      ([file, content]) =>
        `target="$dir"/${$.escape(file)}; mkdir -p "\${target%/*}"; printf '%s' ${$.escape(content)} > "$target"\n`,
    )
    .join("");

type ScenarioOptions = {
  responses: string[];
  args: string[];
  existing?: Record<string, string>;
  boundSeconds?: number;
  prepare?: (paths: { root: string; destination: string }) => Promise<void>;
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

// Every file under a scenario directory, relative to it.
const treeOf = async (
  directory: string,
  files: readonly string[],
): Promise<Record<string, string>> => {
  const entries = await Promise.all(
    files.map(async (file) => {
      const entry = path.join(directory, file);
      const info = await lstat(entry);
      return [
        file,
        info.isSymbolicLink()
          ? `symlink:${await readlink(entry)}`
          : await readFile(entry, "utf-8"),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
};

const runScenario = async ({
  responses,
  args,
  existing,
  boundSeconds = BOUND_SECONDS,
  prepare,
}: ScenarioOptions) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "download-run-artifact-")),
  );
  roots.push(root);
  const bin = path.join(root, "bin");
  const runnerTemp = path.join(root, "runner-temp");
  const destination = path.join(root, "workspace", "destination");
  await mkdir(bin);
  await mkdir(runnerTemp);
  await mkdir(path.join(root, "responses"));
  await writeFile(path.join(bin, "gh"), FAKE_GH);
  await chmod(path.join(bin, "gh"), 0o755);
  if (Bun.which("timeout") === null) {
    await writeFile(path.join(bin, "timeout"), TIMEOUT_STAND_IN);
    await chmod(path.join(bin, "timeout"), 0o755);
  }
  await Promise.all(
    responses.map(async (response, index) =>
      writeFile(path.join(root, "responses", String(index + 1)), response),
    ),
  );
  if (existing !== undefined) {
    for (const [file, content] of Object.entries(existing)) {
      await mkdir(path.dirname(path.join(destination, file)), {
        recursive: true,
      });
      await writeFile(path.join(destination, file), content);
    }
  }
  await prepare?.({ root, destination });
  const started = performance.now();
  const child = Bun.spawn(["bash", SCRIPT, ...args, "--path", destination], {
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      HOME: root,
      TMPDIR: runnerTemp,
      RUNNER_TEMP: runnerTemp,
      FAKE_ROOT: root,
      GH_TOKEN: "test-token",
      GITHUB_RUN_ID: "4242",
      GITHUB_REPOSITORY: "example/repo",
      ARTIFACT_DOWNLOAD_ATTEMPT_SECONDS: String(boundSeconds),
      ARTIFACT_DOWNLOAD_RETRY_PAUSE_SECONDS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const callsFile = path.join(root, "calls");
  const calls = existsSync(callsFile)
    ? (await readFile(callsFile, "utf-8")).trim().split("\n")
    : [];
  return {
    exitCode,
    stdout,
    stderr,
    calls,
    elapsedMs: performance.now() - started,
    destination,
    files: await treeOf(
      destination,
      existsSync(destination)
        ? readdirSync(destination, { recursive: true, encoding: "utf-8" })
            .filter(
              (entry) =>
                !lstatSync(path.join(destination, entry)).isDirectory(),
            )
            .toSorted()
        : [],
    ),
    leftovers: readdirSync(runnerTemp),
  };
};

const errorLines = (output: string) =>
  output.split("\n").filter((line) => line.startsWith("::error::"));

test("a stalled first attempt is stopped at the bound and the retry's files alone reach the destination", async () => {
  const result = await runScenario({
    responses: [HANG, write({ "index.html": "second" })],
    args: ["--name", "e2e-web-build"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toHaveLength(2);
  expect(result.files).toEqual({ "index.html": "second" });
  expect(result.stderr).toContain(
    `Artifact download attempt 1 for artifact 'e2e-web-build' timed out after ${String(BOUND_SECONDS)} s`,
  );
  expect(result.stdout).toContain(
    "Downloaded artifact 'e2e-web-build' from run 4242 of example/repo: 1 files,",
  );
  expect(result.stdout).toContain("(attempt 2)");
  expect(result.elapsedMs).toBeLessThan(15_000);
  expect(result.leftovers).toEqual([]);
});

// timeout: this case deliberately waits for two 2-second process-group deadlines plus child cleanup.
test("two stalled attempts fail with one error naming the artifact, both outcomes and the run", async () => {
  const result = await runScenario({
    responses: [HANG, HANG],
    args: ["--name", "e2e-web-build"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.calls).toHaveLength(2);
  expect(errorLines(result.stdout + result.stderr)).toHaveLength(1);
  const [error] = errorLines(result.stdout);
  expect(error).toStartWith(
    `::error::Artifact download failed for artifact 'e2e-web-build' in run 4242 of example/repo: attempt 1 timed out after ${String(BOUND_SECONDS)} s`,
  );
  expect(error).toContain(
    `; attempt 2 timed out after ${String(BOUND_SECONDS)} s`,
  );
  expect(existsSync(result.destination)).toBe(false);
}, 10_000);

test("the download names this run, its repository and the artifact selector", async () => {
  const result = await runScenario({
    responses: [
      list("playwright-blob-1", "other"),
      write({ "playwright-blob-1/report-1.zip": "1" }),
    ],
    args: ["--pattern", "playwright-blob-*"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toHaveLength(2);
  expect(result.calls[0]).toStartWith(
    "api --paginate repos/example/repo/actions/runs/4242/artifacts?per_page=100",
  );
  expect(result.calls[1]).toStartWith(
    "run download 4242 --repo example/repo --pattern playwright-blob-* --dir ",
  );
  // Without --merge every match keeps its own directory.
  expect(result.files).toEqual({ "playwright-blob-1/report-1.zip": "1" });
});

test("a merged pattern download puts the files of every match in the destination", async () => {
  const result = await runScenario({
    responses: [
      list("api-test-timings-api-1", "api-test-timings-api-2"),
      write({
        "api-test-timings-api-1/api-1.json": "1",
        "api-test-timings-api-2/nested/api-2.json": "2",
      }),
    ],
    args: ["--pattern", "api-test-timings-api-*", "--merge"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.files).toEqual({
    "api-1.json": "1",
    "nested/api-2.json": "2",
  });
  expect(result.stdout).toContain(
    "Downloaded artifacts matching 'api-test-timings-api-*' from run 4242 of example/repo: 2 files,",
  );
});

test("a merged pattern download refuses a file two artifacts share and leaves the destination untouched", async () => {
  const result = await runScenario({
    responses: [
      list("playwright-blob-1", "playwright-blob-2"),
      write({
        "playwright-blob-1/only-first.zip": "only",
        "playwright-blob-1/report.zip": "first",
        "playwright-blob-2/report.zip": "second",
      }),
    ],
    args: ["--pattern", "playwright-blob-*", "--merge"],
  });
  expect(result.exitCode).toBe(1);
  // The listing, then one download: a collision is not retried.
  expect(result.calls).toHaveLength(2);
  expect(errorLines(result.stdout)).toEqual([
    "::error::Artifact download for artifacts matching 'playwright-blob-*' in run 4242 of example/repo: 'report.zip' is in more than one matching artifact (one is 'playwright-blob-2'); merged artifacts must not share file names",
  ]);
  expect(existsSync(result.destination)).toBe(false);
  expect(result.leftovers).toEqual([]);
});

test("a stopped attempt leaves no partial file in an existing destination", async () => {
  const result = await runScenario({
    responses: [HANG, write({ "api-test-durations.json": "{}" })],
    args: ["--name", "api-test-durations-plan"],
    existing: { "unrelated.txt": "kept" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.files).toEqual({
    "api-test-durations.json": "{}",
    "unrelated.txt": "kept",
  });
  expect(result.leftovers).toEqual([]);
});

// timeout: this case deliberately waits for two 2-second process-group deadlines plus child cleanup.
test("stopped attempts that never complete leave no file behind", async () => {
  const result = await runScenario({
    responses: [list("playwright-blob-1"), HANG, HANG],
    args: ["--pattern", "playwright-blob-*", "--merge"],
    existing: { "unrelated.txt": "kept" },
  });
  expect(result.exitCode).toBe(1);
  expect(result.files).toEqual({ "unrelated.txt": "kept" });
  expect(result.leftovers).toEqual([]);
}, 10_000);

test("a pattern that matches no artifact of the run downloads nothing and succeeds", async () => {
  const result = await runScenario({
    responses: [list("generated-sources-abc", "api-test-durations-plan")],
    args: ["--pattern", "playwright-blob-*", "--merge"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0]).toStartWith("api --paginate ");
  expect(existsSync(result.destination)).toBe(true);
  expect(result.files).toEqual({});
  expect(result.stdout).toContain(
    "No artifact of run 4242 of example/repo matches 'playwright-blob-*'; nothing to download.",
  );
});

test.each([
  { args: ["--name", "a"], reason: "no destination" },
  {
    args: ["--name", "a", "--pattern", "b", "--path", "unused"],
    reason: "two selectors",
  },
  {
    args: ["--name", "a", "--merge", "--path", "unused"],
    reason: "merge without a pattern",
  },
])(
  "arguments with $reason are refused before any download",
  async ({ args }) => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "download-run-artifact-")),
    );
    roots.push(root);
    const child = Bun.spawn(["bash", SCRIPT, ...args], {
      env: {
        PATH: process.env["PATH"] ?? "",
        GH_TOKEN: "test-token",
        GITHUB_RUN_ID: "4242",
        GITHUB_REPOSITORY: "example/repo",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(2);
  },
);

test.each([401, 403, 404])(
  "permanent HTTP %i downloads fail once without an outer retry",
  async (status) => {
    const result = await runScenario({
      responses: [
        fail("permanent failure", status),
        write({ unexpected: "retry" }),
      ],
      args: ["--name", "required"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(errorLines(result.stdout)).toEqual([
      `::error::Artifact download failed for artifact 'required' in run 4242 of example/repo: attempt 1 exit code 1 (GitHub command failed: HTTP ${String(status)}, attempt 1/4 (exit 1))`,
    ]);
    expect(result.stdout + result.stderr).not.toContain("private trace line");
    expect(result.stderr).not.toContain("retrying in");
    expect(existsSync(result.destination)).toBe(false);
    expect(result.leftovers).toEqual([]);
  },
);

test("unknown download failures stay single-shot", async () => {
  const result = await runScenario({
    responses: [
      "echo 'unknown decoder failure' >&2; exit 23",
      write({ unexpected: "retry" }),
    ],
    args: ["--name", "required"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.calls).toHaveLength(1);
  expect(result.stdout).toContain(
    "exit code 23 (GitHub command failed: HTTP 0, attempt 1/4 (exit 23))",
  );
  expect(result.leftovers).toEqual([]);
});

test.each([
  fail("unavailable", 503),
  `echo 'Get "https://api.github.com/example": EOF' >&2; exit 1`,
])(
  "canonical classified recovery stays inside the first outer attempt: %s",
  async (response) => {
    const result = await runScenario({
      responses: [response, write({ "recovered.json": "{}" })],
      args: ["--name", "required"],
      // Canonical recovery sleeps 1–3 seconds before its second request.
      boundSeconds: 8,
    });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.files).toEqual({ "recovered.json": "{}" });
    expect(result.stdout).toContain("(attempt 1)");
    expect(result.stderr).not.toContain("retrying in");
    expect(result.leftovers).toEqual([]);
  },
);

test.each([401, 403, 404, 0])(
  "pattern listing failure HTTP %i does not trigger a fallback download",
  async (status) => {
    const result = await runScenario({
      responses: [
        status === 0
          ? "echo 'unknown listing failure' >&2; exit 23"
          : fail("permanent failure", status),
        write({ "unexpected/file": "retry" }),
      ],
      args: ["--pattern", "optional-*"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.calls.at(0)).toStartWith("api --paginate ");
    expect(result.stdout).toContain("Artifact listing failed");
    expect(existsSync(result.destination)).toBe(false);
    expect(result.leftovers).toEqual([]);
  },
);

test("a listing deadline may conservatively try the actual download", async () => {
  const result = await runScenario({
    responses: [HANG, write({ "optional-one/file": "downloaded" })],
    args: ["--pattern", "optional-*"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toHaveLength(2);
  expect(result.files).toEqual({ "optional-one/file": "downloaded" });
  expect(result.stderr).toContain("timed out; downloading");
  expect(result.leftovers).toEqual([]);
});

test("merging includes hidden artifact roots and preserves arbitrary file names and contents", async () => {
  const unusual = "nested/line\nquote'ユニコード%$(touch injected).txt";
  const content = "a'\n$(touch injected) `literal` \\";
  const result = await runScenario({
    responses: [
      list(".hidden", "visible"),
      write({
        [`.hidden/${unusual}`]: content,
        ".hidden/.dotfile": "hidden",
        "visible/ordinary": "visible",
      }),
    ],
    args: ["--pattern", "*", "--merge"],
  });
  expect(result.exitCode).toBe(0);
  expect(result.files).toEqual({
    [unusual]: content,
    ".dotfile": "hidden",
    ordinary: "visible",
  });
  expect(result.stdout).toContain(": 3 files,");
  expect(result.leftovers).toEqual([]);
});

test("newline collisions are detected and escaped before destination writes", async () => {
  const file = "line\n::error::unexpected.zip";
  const result = await runScenario({
    responses: [
      list("first", "second"),
      write({ [`first/${file}`]: "one", [`second/${file}`]: "two" }),
    ],
    args: ["--pattern", "*", "--merge"],
    existing: { keep: "original" },
  });
  expect(result.exitCode).toBe(1);
  expect(result.files).toEqual({ keep: "original" });
  expect(errorLines(result.stdout)).toHaveLength(1);
  expect(result.stdout).toContain("line%0A::error::unexpected.zip");
  expect(result.leftovers).toEqual([]);
});

test.each(["file-over-directory", "directory-over-file"])(
  "validates the complete %s overlay before any file is changed",
  async (kind) => {
    const existing =
      kind === "file-over-directory"
        ? { "node/child": "original", keep: "kept" }
        : { node: "original", keep: "kept" };
    const incoming =
      kind === "file-over-directory"
        ? { node: "replacement", new: "new" }
        : { "node/child": "replacement", new: "new" };
    const result = await runScenario({
      responses: [write(incoming)],
      args: ["--name", "required"],
      existing,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("file/directory type conflict");
    expect(result.files).toEqual(existing);
    expect(result.leftovers).toEqual([]);
  },
);

test.each(["root", "ancestor", "descendant", "dangling"])(
  "rejects an affected %s symlink without outside writes",
  async (kind) => {
    let outside = "";
    const result = await runScenario({
      responses: [write({ "nested/entry": "new", new: "new" })],
      args: ["--name", "required"],
      prepare: async ({ root, destination }) => {
        outside = path.join(root, "outside");
        await mkdir(outside);
        await writeFile(path.join(outside, "keep"), "original");
        if (kind === "ancestor") {
          await symlink(outside, path.dirname(destination));
        } else {
          await mkdir(path.dirname(destination), { recursive: true });
          if (kind === "root") {
            await symlink(outside, destination);
          } else {
            await mkdir(destination);
            await writeFile(path.join(destination, "keep"), "kept");
            await symlink(
              kind === "dangling" ? path.join(root, "absent") : outside,
              path.join(destination, "nested"),
            );
          }
        }
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("symlink");
    expect(await readFile(path.join(outside, "keep"), "utf-8")).toBe(
      "original",
    );
    expect(existsSync(path.join(outside, "entry"))).toBe(false);
    expect(existsSync(path.join(outside, "new"))).toBe(false);
    expect(existsSync(path.join(result.destination, "new"))).toBe(false);
    expect(result.leftovers).toEqual([]);
  },
);

test.each(["symlink", "fifo"])(
  "source %s nodes are refused before the overlay changes",
  async (kind) => {
    const special =
      kind === "symlink"
        ? 'ln -s "$FAKE_ROOT/outside" "$dir/special"'
        : 'mkfifo "$dir/special"';
    const result = await runScenario({
      responses: [write({ new: "new" }) + special],
      args: ["--name", "required"],
      existing: { keep: "kept" },
      prepare: async ({ root }) => {
        await writeFile(path.join(root, "outside"), "original");
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("symlink or special node");
    expect(result.files).toEqual({ keep: "kept" });
    expect(result.leftovers).toEqual([]);
  },
);

test("read-only source files can be flattened without modifying their source directories", async () => {
  const result = await runScenario({
    responses: [
      list(".hidden"),
      `${write({ ".hidden/readonly": "retained" })}chmod 444 "$dir/.hidden/readonly"`,
    ],
    args: ["--pattern", "*", "--merge"],
    existing: { keep: "kept" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.files).toEqual({ readonly: "retained", keep: "kept" });
  expect(result.leftovers).toEqual([]);
});

test.each([124, 137])(
  "an early command exit %i is not retried as a deadline",
  async (status) => {
    for (const selector of ["--name", "--pattern"]) {
      const result = await runScenario({
        responses: [`exit ${String(status)}`, write({ unexpected: "retry" })],
        args: [selector, "required"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.stdout).toContain(
        selector === "--name"
          ? `exit code ${String(status)}`
          : "Artifact listing failed",
      );
      expect(result.stdout + result.stderr).not.toContain("timed out");
      expect(existsSync(result.destination)).toBe(false);
      expect(result.leftovers).toEqual([]);
    }
  },
);

test("affected hardlinks are rejected before any existing destination file changes", async () => {
  let outside = "";
  const result = await runScenario({
    responses: [write({ entry: "replacement", keep: "changed", new: "new" })],
    args: ["--name", "required"],
    existing: { keep: "original" },
    prepare: async ({ root, destination }) => {
      outside = path.join(root, "outside");
      await writeFile(outside, "outside original");
      await link(outside, path.join(destination, "entry"));
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("affected hardlink");
  expect(await readFile(outside, "utf-8")).toBe("outside original");
  expect(result.files).toEqual({ keep: "original", entry: "outside original" });
  expect(result.leftovers).toEqual([]);
});

test("unrelated hardlinks and symlinks survive a valid overlay", async () => {
  let unrelatedLink = "";
  let outside = "";
  const result = await runScenario({
    responses: [write({ entry: "new" })],
    args: ["--name", "required"],
    existing: { keep: "original" },
    prepare: async ({ root, destination }) => {
      outside = path.join(root, "outside");
      unrelatedLink = path.join(destination, "symlink");
      await writeFile(outside, "outside original");
      await link(outside, path.join(destination, "hardlink"));
      await symlink(outside, unrelatedLink);
    },
  });
  expect(result.exitCode).toBe(0);
  expect(result.files["entry"]).toBe("new");
  expect(result.files["keep"]).toBe("original");
  expect(result.files["hardlink"]).toBe("outside original");
  expect((await lstat(unrelatedLink)).isSymbolicLink()).toBe(true);
  expect(await readlink(unrelatedLink)).toBe(outside);
  expect(result.leftovers).toEqual([]);
});
