import { expect, test } from "bun:test";
import {
  mkdtemp,
  chmod,
  readFile,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HELPER = path.resolve(import.meta.dir, "gh-retry.sh");
const FAKE_GH = `#!/usr/bin/env python3
import os,sys,json,pathlib,select
root=pathlib.Path(os.environ['FAKE_ROOT'])
count=root/'count'
attempt=int(count.read_text())+1 if count.exists() else 1
count.write_text(str(attempt))
args=sys.argv[1:]
stdin=sys.stdin.buffer.read()
with (root/'calls').open('a') as f:f.write(json.dumps({'args':args,'stdin':stdin.hex()})+'\\n')
if os.environ['FAKE_WATCHDOG_STARTUP']=='interrupted':
 while not (root/'startup-interrupted').exists():select.select([],[],[],0.01)
responses=json.loads(os.environ['FAKE_RESPONSES'])
response=responses[min(attempt-1,len(responses)-1)]
if 'download' in args:
 destination=args[args.index('--dir')+1]
 for arg in args:
  if arg.startswith('--dir='):destination=arg[6:]
 target=pathlib.Path(destination)
 target.mkdir(parents=True,exist_ok=True)
 with (root/'destinations').open('a') as f:f.write(str(target)+'\\n')
 (target/('partial.txt' if response['exit'] else 'asset.txt')).write_text('partial' if response['exit'] else 'complete')
sys.stdout.buffer.write(bytes.fromhex(response.get('output','')))
if response.get('http') is not None:sys.stderr.write('< HTTP/2.0 '+str(response['http'])+'\\n')
if response.get('after') is not None:sys.stderr.write('< Retry-After: '+str(response['after'])+'\\n')
sys.stderr.write(response.get('error','')+'\\n')
sys.stderr.write('private-token-do-not-print\\n')
if response.get('hang'):
 sys.stdout.buffer.flush();sys.stderr.flush()
 (root/'hanging').touch()
 while True:select.select([],[],[],1)
sys.exit(response['exit'])
`;
const FAKE_SLEEP = `#!/usr/bin/env python3
import os,sys,pathlib,select
seconds=int(sys.argv[1])
if seconds>=50 and os.environ.get('FAKE_EXPIRE_WATCHDOG')=='1':
 while not (pathlib.Path(os.environ['FAKE_ROOT'])/'hanging').exists():select.select([],[],[],0.01)
elif seconds>=50:
 parent=os.getppid()
 while os.getppid()==parent:select.select([],[],[],0.01)
else:
 with (pathlib.Path(os.environ['FAKE_ROOT'])/'sleeps').open('a') as f:f.write(str(seconds)+'\\n')
`;

const FAKE_DATE = `#!/usr/bin/env python3
import sys
if '-d' in sys.argv or '-f' in sys.argv:
 if 'Wed, 07 Oct 2026 12:00:07 GMT' not in sys.argv:sys.exit(1)
 print(1007)
else:print(1000)
`;

// Model GNU Bash's inherited EXIT cleanup before watchdog trap setup on every
// platform. DEBUG inheritance reaches the first subshell command.
const INTERRUPT_WATCHDOG_STARTUP = `set -T
interrupt_watchdog_startup() {
  if ((BASH_SUBSHELL > 0)) && [[ "$BASH_COMMAND" == 'sleep "$remaining"' ]]; then
    while [[ ! -s "$FAKE_ROOT/calls" ]]; do /bin/sleep 0.01; done
    : > "$FAKE_ROOT/startup-interrupted"
    trap cleanup EXIT
    exit 143
  fi
}
trap interrupt_watchdog_startup DEBUG
`;

type FakeResponse = {
  exit: number;
  http?: number;
  after?: number | string;
  output?: string;
  hang?: boolean;
  error?: string;
};
type ScenarioOptions = {
  args?: string[];
  responses: FakeResponse[];
  input?: string;
  existingAsset?: boolean;
  expireWatchdog?: boolean;
  watchdogStartup?: "normal" | "interrupted";
};
const scenario = async ({
  args = ["api", "repos/example/project"],
  responses,
  input = "",
  existingAsset = false,
  expireWatchdog = false,
  watchdogStartup = "normal",
}: ScenarioOptions) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gh-retry-test-"));
  await writeFile(path.join(directory, "gh"), FAKE_GH);
  await writeFile(path.join(directory, "sleep"), FAKE_SLEEP);
  await writeFile(path.join(directory, "date"), FAKE_DATE);
  await chmod(path.join(directory, "date"), 0o700);
  await chmod(path.join(directory, "gh"), 0o700);
  await chmod(path.join(directory, "sleep"), 0o700);
  const shellStartup = path.join(directory, "shell-startup");
  await writeFile(shellStartup, INTERRUPT_WATCHDOG_STARTUP);
  const destination = path.join(directory, "output");
  if (existingAsset) {
    await mkdir(destination);
    await writeFile(path.join(destination, "asset.txt"), "original");
  }
  const process = Bun.spawn(
    [
      "bash",
      HELPER,
      ...args.map((arg) => (arg === "DESTINATION" ? destination : arg)),
    ],
    {
      cwd: directory,
      env: {
        ...Bun.env,
        ...(watchdogStartup === "interrupted"
          ? { BASH_ENV: shellStartup }
          : {}),
        PATH: `${directory}:${Bun.env["PATH"] ?? ""}`,
        FAKE_ROOT: directory,
        FAKE_WATCHDOG_STARTUP: watchdogStartup,
        FAKE_EXPIRE_WATCHDOG: expireWatchdog ? "1" : "0",
        FAKE_RESPONSES: JSON.stringify(responses),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await process.stdin.write(input);
  await process.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ]);
  const calls = (await readFile(path.join(directory, "calls"), "utf-8"))
    .trim()
    .split("\n");
  const sleeps = (await Bun.file(path.join(directory, "sleeps")).exists())
    ? (await readFile(path.join(directory, "sleeps"), "utf-8"))
        .trim()
        .split("\n")
        .map(Number)
    : [];
  const downloaded = (await Bun.file(
    path.join(destination, "asset.txt"),
  ).exists())
    ? await readFile(path.join(destination, "asset.txt"), "utf-8")
    : null;
  const partialExists = await Bun.file(
    path.join(destination, "partial.txt"),
  ).exists();
  const destinations = (await Bun.file(
    path.join(directory, "destinations"),
  ).exists())
    ? (await readFile(path.join(directory, "destinations"), "utf-8"))
        .trim()
        .split("\n")
    : [];
  const startupInterrupted = await Bun.file(
    path.join(directory, "startup-interrupted"),
  ).exists();
  await rm(directory, { recursive: true, force: true });
  expect(stderr).not.toContain("private-token-do-not-print");
  return {
    exit,
    stdout: Buffer.from(stdout),
    stderr,
    calls,
    sleeps,
    downloaded,
    partialExists,
    destinations,
    startupInterrupted,
  };
};

const unavailable = { exit: 1, http: 503 };
const success = { exit: 0, http: 200, output: "6f6b" };

test("watchdog termination before trap setup preserves the command response", async () => {
  const result = await scenario({
    responses: [success],
    watchdogStartup: "interrupted",
  });
  expect(result.startupInterrupted).toBe(true);
  expect(result.exit).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.stdout).toEqual(Buffer.from("ok"));
});

test("503 then success retries once and discards partial binary stdout", async () => {
  const result = await scenario({
    responses: [
      { ...unavailable, output: "00ff" },
      { ...success, output: "00ff010080" },
    ],
  });
  expect(result.exit).toBe(0);
  expect(result.calls).toHaveLength(2);
  expect(result.stdout).toEqual(Buffer.from([0, 255, 1, 0, 128]));
  expect(result.sleeps).toHaveLength(1);
  expect(result.stderr).toContain("HTTP 503");
  expect(result.stderr).toContain("attempt 1/4");
});

test("persistent transient failure makes exactly four attempts", async () => {
  const result = await scenario({
    responses: [{ ...unavailable, output: "00ff" }],
  });
  expect(result.exit).toBe(1);
  expect(result.calls).toHaveLength(4);
  expect(result.stdout).toEqual(Buffer.alloc(0));
  expect(result.sleeps).toHaveLength(3);
  for (const attempt of [1, 2, 3, 4]) {
    expect(result.stderr).toContain(`HTTP 503, attempt ${attempt}/4`);
  }
});

test("429 and secondary 403 honor Retry-After while ordinary 403 fails once", async () => {
  for (const http of [429, 403]) {
    const result = await scenario({
      responses: [{ exit: 1, http, after: 7 }, success],
    });
    expect(result.exit).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.sleeps).toEqual([7]);
  }
  const result = await scenario({
    responses: [{ exit: 1, http: 403 }, success],
  });
  expect(result.exit).toBe(1);
  expect(result.calls).toHaveLength(1);
  expect(result.sleeps).toEqual([]);
});

test("404, absent or successful HTTP status on errors and exhausted delay budget do not retry", async () => {
  for (const response of [
    { exit: 1, http: 404 },
    { exit: 1 },
    { exit: 1, http: 200 },
    { exit: 1, http: 429, after: 61 },
  ]) {
    const result = await scenario({ responses: [response, success] });
    expect(result.exit).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.sleeps).toEqual([]);
  }
});

test("HTTP writes and GraphQL mutations stay single-shot", async () => {
  const operations = [
    ...["POST", "PATCH", "PUT", "DELETE"].map((method) => [
      "api",
      "repos/example/project",
      "--method",
      method,
    ]),
    ["api", "repos/example/project", "-f", "body=value"],
    ["api", "repos/example/project", "-XPOST"],
    ["api", "graphql", "-f", "query=mutation { updateThing { id } }"],
    [
      "api",
      "graphql",
      "-f",
      "query=query Read { viewer { login } } mutation Write { updateThing { id } }",
      "-f",
      "operationName=Write",
    ],
    ["release", "upload", "v1", "asset.txt", "--clobber", "--clobber=false"],
    ["release", "create", "v1"],
    ["release", "edit", "v1", "--draft=false"],
    ["release", "upload", "v1", "asset.txt"],
    ["release", "upload", "v1", "--", "asset.txt", "--clobber"],
  ];
  for (const args of operations) {
    const result = await scenario({ args, responses: [unavailable, success] });
    expect(result.exit).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.sleeps).toEqual([]);
  }
});

test("GraphQL reads and clobber uploads admit transient recovery", async () => {
  for (const args of [
    ["api", "graphql", "-f", "query=query { viewer { login } }"],
    ["release", "upload", "v1", "asset.txt", "--clobber"],
  ]) {
    const result = await scenario({ args, responses: [unavailable, success] });
    expect(result.exit).toBe(0);
    expect(result.calls).toHaveLength(2);
  }
});

test("explicit GET replays stdin byte-for-byte for every attempt", async () => {
  const input = '{"value":"Příliš 🧑‍⚖️"}\n';
  for (const fields of [["--input", "-"], ["--field=body=@-"], ["-Fbody=@-"]]) {
    const result = await scenario({
      args: ["api", "repos/example/project", "--method", "GET", ...fields],
      responses: [unavailable, success],
      input,
    });
    expect(result.exit).toBe(0);
    expect(result.calls).toHaveLength(2);
    for (const call of result.calls) {
      expect(call).toContain(Buffer.from(input).toString("hex"));
    }
  }
});

test("downloads publish only successful attempt files and refuse existing release assets", async () => {
  for (const subcommand of ["run", "release"]) {
    const result = await scenario({
      args: [subcommand, "download", "123", "--dir", "DESTINATION"],
      responses: [unavailable, success],
    });
    expect(result.exit).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.downloaded).toBe("complete");
    expect(result.partialExists).toBe(false);
    expect(
      result.destinations.every(
        (destination) => !destination.endsWith("/output"),
      ),
    ).toBe(true);
  }
  const result = await scenario({
    args: ["release", "download", "v1", "--dir", "DESTINATION"],
    responses: [success],
    existingAsset: true,
  });
  expect(result.exit).toBe(1);
  expect(result.calls).toHaveLength(1);
  expect(result.downloaded).toBe("original");
  expect(result.stderr).toContain("already contains an asset");
});

test("the wall budget terminates an unfinished API request and discards its output", async () => {
  const result = await scenario({
    responses: [{ ...unavailable, output: "00ff", hang: true }],
    expireWatchdog: true,
  });
  expect(result.exit).toBe(124);
  expect(result.calls).toHaveLength(1);
  expect(result.stdout).toEqual(Buffer.alloc(0));
  expect(result.stderr).toContain("retry budget exhausted");
});

test("Retry-After HTTP dates use the same bounded recovery path", async () => {
  const result = await scenario({
    responses: [
      { exit: 1, http: 429, after: "Wed, 07 Oct 2026 12:00:07 GMT" },
      success,
    ],
  });
  expect(result.exit).toBe(0);
  expect(result.calls).toHaveLength(2);
  expect(result.sleeps).toEqual([7]);
});

const connectionReset =
  'Get "https://api.github.com/example": read tcp 127.0.0.1:1234->127.0.0.1:443: read: connection reset by peer';
const transportErrors = [
  connectionReset,
  "* dial tcp 127.0.0.1:443: i/o timeout",
  'Get "https://api.github.com/example": net/http: TLS handshake timeout',
  "* dial tcp: lookup api.github.com: no such host",
  'Get "https://api.github.com/example": EOF',
  "* unexpected EOF",
  'Get "https://api.github.com/example": dial tcp 127.0.0.1:443: connect: connection refused',
];

for (const error of transportErrors) {
  test.each(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"])(
    `recognized transport failures recover only for safe reads: ${error} (%s)`,
    async (method) => {
      const result = await scenario({
        args: ["api", "repos/example/project", "--method", method],
        responses: [{ exit: 1, error, output: "00ff" }, success],
      });
      expect(result.stderr).not.toContain(error);
      if (method === "GET" || method === "HEAD") {
        expect(result.exit).toBe(0);
        expect(result.calls).toHaveLength(2);
        expect(result.sleeps).toHaveLength(1);
        expect(result.stdout).toEqual(Buffer.from("ok"));
        return;
      }
      expect(result.exit).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.sleeps).toEqual([]);
    },
  );
}

test("unknown non-HTTP errors and errors after a non-transient HTTP response fail fast", async () => {
  for (const response of [
    { exit: 1, error: "unsupported command option" },
    { exit: 1, error: "error decoding JSON: unexpected EOF" },
    {
      exit: 1,
      error:
        'Get "https://api.github.com/example": x509: certificate signed by unknown authority',
    },
    { exit: 1, error: "> Authorization: connection reset by peer" },
    { exit: 1, http: 400, error: connectionReset },
  ]) {
    const result = await scenario({ responses: [response, success] });
    expect(result.exit).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.sleeps).toEqual([]);
  }
});

test("downloads refuse a named output file before calling gh", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gh-retry-output-"));
  const marker = path.join(directory, "gh-called");
  await writeFile(path.join(directory, "gh"), `#!/bin/sh\ntouch "${marker}"\n`);
  await chmod(path.join(directory, "gh"), 0o700);
  try {
    for (const flag of [
      ["-O", "asset.txt"],
      ["-Oasset.txt"],
      ["--output", "asset.txt"],
      ["--output=asset.txt"],
    ]) {
      const result = Bun.spawnSync(
        ["bash", HELPER, "release", "download", "v1", ...flag],
        {
          cwd: directory,
          env: { ...Bun.env, PATH: `${directory}:${Bun.env["PATH"] ?? ""}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("--output is not supported");
      expect(await Bun.file(marker).exists()).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transport recovery keeps writes single-shot even when HTTP recovery admits them", async () => {
  for (const args of [
    ["api", "graphql", "-f", "query=query { viewer { login } }"],
    ["release", "upload", "v1", "asset.txt", "--clobber"],
    ["run", "cancel", "123"],
  ]) {
    const result = await scenario({
      args,
      responses: [{ exit: 1, error: connectionReset }, success],
    });
    expect(result.exit).toBe(1);
    expect(result.calls).toHaveLength(1);
  }
});

test("recognized transport recovery is bounded and also covers high-level reads", async () => {
  const failed = { exit: 1, error: connectionReset };
  const persistent = await scenario({ responses: [failed] });
  expect(persistent.exit).toBe(1);
  expect(persistent.calls).toHaveLength(4);
  expect(persistent.sleeps).toHaveLength(3);
  for (const args of [
    ["run", "view", "123"],
    ["release", "view", "v1"],
  ]) {
    const result = await scenario({ args, responses: [failed, success] });
    expect(result.exit).toBe(0);
    expect(result.calls).toHaveLength(2);
  }
});

test("a new request without a response does not inherit a redirect status", async () => {
  const result = await scenario({
    responses: [
      {
        exit: 1,
        http: 302,
        error:
          '* Request to https://api.github.com/example\nGet "https://api.github.com/example": EOF',
      },
      success,
    ],
  });
  expect(result.exit).toBe(0);
  expect(result.calls).toHaveLength(2);
  expect(result.stderr).toContain("transport error");
});
