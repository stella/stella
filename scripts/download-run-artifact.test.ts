import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "download-run-artifact.sh");
// Short for fast tests, long enough for two shell starts on a busy host.
const BOUND_SECONDS = 2;
const SCENARIO_TIMEOUT_MS = 30_000;

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

const HANG = `echo partial > "$dir/partial.txt"
exec sleep 20
`;
// The artifact listing a pattern download reads first.
const list = (...names: string[]) =>
  names.map((name) => `echo '${name}'\n`).join("");
const fail = (message: string, status: number) =>
  `echo 'private trace line' >&2
echo 'gh: ${message} (HTTP ${String(status)})' >&2
exit 1
`;
const write = (files: Record<string, string>) =>
  Object.entries(files)
    .map(
      ([file, content]) =>
        `mkdir -p "$(dirname "$dir/${file}")"\nprintf '%s' '${content}' > "$dir/${file}"\n`,
    )
    .join("");

type ScenarioOptions = {
  responses: string[];
  args: string[];
  existing?: Record<string, string>;
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

const treeOf = async (directory: string): Promise<Record<string, string>> => {
  if (!existsSync(directory)) {
    return {};
  }
  const files = [
    ...new Bun.Glob("**/*").scanSync({ cwd: directory, dot: true }),
  ].toSorted();
  const entries = await Promise.all(
    files.map(
      async (file) =>
        [file, await readFile(path.join(directory, file), "utf-8")] as const,
    ),
  );
  return Object.fromEntries(entries);
};

const runScenario = async ({ responses, args, existing }: ScenarioOptions) => {
  const root = await mkdtemp(path.join(tmpdir(), "download-run-artifact-"));
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
      ARTIFACT_DOWNLOAD_ATTEMPT_SECONDS: String(BOUND_SECONDS),
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
    files: await treeOf(destination),
    leftovers: readdirSync(runnerTemp),
  };
};

const errorLines = (output: string) =>
  output.split("\n").filter((line) => line.startsWith("::error::"));

test(
  "a stalled first attempt is stopped at the bound and the retry's files alone reach the destination",
  async () => {
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
  },
  SCENARIO_TIMEOUT_MS,
);

test(
  "two stalled attempts fail with one error naming the artifact, both outcomes and the run",
  async () => {
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
  },
  SCENARIO_TIMEOUT_MS,
);

test(
  "a failed attempt is retried once and the retry's download succeeds",
  async () => {
    const result = await runScenario({
      responses: [
        fail("Not Found", 404),
        write({ "api-test-durations.json": "{}" }),
      ],
      args: ["--name", "api-test-durations-plan"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.files).toEqual({ "api-test-durations.json": "{}" });
    expect(result.stderr).toContain(
      "Artifact download attempt 1 for artifact 'api-test-durations-plan' exit code 1 (GitHub command failed: HTTP 404, attempt 1/4 (exit 1)); retrying in 0s",
    );
  },
  SCENARIO_TIMEOUT_MS,
);

test(
  "two failed attempts report the last stderr line of each attempt",
  async () => {
    const result = await runScenario({
      responses: [fail("Not Found", 404), fail("Bad credentials", 401)],
      args: ["--name", "generated-sources-abc"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.calls).toHaveLength(2);
    expect(errorLines(result.stdout + result.stderr)).toEqual([
      "::error::Artifact download failed for artifact 'generated-sources-abc' in run 4242 of example/repo: attempt 1 exit code 1 (GitHub command failed: HTTP 404, attempt 1/4 (exit 1)); attempt 2 exit code 1 (GitHub command failed: HTTP 401, attempt 1/4 (exit 1))",
    ]);
    expect(result.stdout + result.stderr).not.toContain("private trace line");
    expect(existsSync(result.destination)).toBe(false);
  },
  SCENARIO_TIMEOUT_MS,
);

test(
  "the download names this run, its repository and the artifact selector",
  async () => {
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
  },
  SCENARIO_TIMEOUT_MS,
);

test(
  "a merged pattern download puts the files of every match in the destination",
  async () => {
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
  },
  SCENARIO_TIMEOUT_MS,
);

test(
  "a merged pattern download refuses a file two artifacts share and leaves the destination untouched",
  async () => {
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
  },
  SCENARIO_TIMEOUT_MS,
);

test(
  "a stopped attempt leaves no partial file in an existing destination",
  async () => {
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
  },
  SCENARIO_TIMEOUT_MS,
);

test(
  "stopped attempts that never complete leave no file behind",
  async () => {
    const result = await runScenario({
      responses: [list("playwright-blob-1"), HANG, HANG],
      args: ["--pattern", "playwright-blob-*", "--merge"],
      existing: { "unrelated.txt": "kept" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.files).toEqual({ "unrelated.txt": "kept" });
    expect(result.leftovers).toEqual([]);
  },
  SCENARIO_TIMEOUT_MS,
);

test(
  "a pattern that matches no artifact of the run downloads nothing and succeeds",
  async () => {
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
  },
  SCENARIO_TIMEOUT_MS,
);

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
    const root = await mkdtemp(path.join(tmpdir(), "download-run-artifact-"));
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
