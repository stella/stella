import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const HELPER = path.resolve(import.meta.dir, "gh-dispatch-workflow.sh");
const TITLE = "Main heavy suites abc123";

// A fake GitHub: dispatches answer from FAKE_DISPATCHES and may create a run
// that the run list shows after `visibleAfter` further list calls.
const FAKE_GH = `#!/usr/bin/env python3
import json,os,pathlib,sys
root=pathlib.Path(os.environ['FAKE_ROOT'])
args=sys.argv[1:]
sys.stdin.buffer.read()
state_file=root/'state.json'
state=json.loads(state_file.read_text())
endpoint=next((a for a in args if a.startswith('/')),'')
method=args[args.index('--method')+1] if '--method' in args else 'GET'
with (root/'calls').open('a') as f:f.write(json.dumps({'method':method,'endpoint':endpoint,'args':args})+'\\n')
sys.stderr.write('private-token-do-not-print\\n')
def fail(http,after=None):
 if http is None:sys.stderr.write('* Post "https://api.github.com'+endpoint+'": EOF\\n')
 else:
  sys.stderr.write('< HTTP/2.0 '+str(http)+'\\n')
  if after is not None:sys.stderr.write('< Retry-After: '+str(after)+'\\n')
  sys.stderr.write('gh: request failed (HTTP '+str(http)+')\\n')
 state_file.write_text(json.dumps(state));sys.exit(1)
if endpoint.endswith('/dispatches'):
 responses=json.loads(os.environ['FAKE_DISPATCHES'])
 response=responses[min(state['posts'],len(responses)-1)]
 state['posts']+=1
 if response.get('create'):
  state['runs'].append({'id':1000+state['posts'],'display_title':os.environ['FAKE_TITLE'],'visible_from':state['lists']+response.get('visibleAfter',0)+1})
 if response['http']==204:
  state_file.write_text(json.dumps(state));sys.exit(0)
 fail(response['http'],response.get('after'))
if '/runs?' in endpoint and method=='GET':
 state['lists']+=1
 if os.environ.get('FAKE_LIST_FAILS')=='1':fail(404)
 runs=[r for r in state['runs'] if r['visible_from']<=state['lists']]
 state_file.write_text(json.dumps(state))
 print(json.dumps([{'workflow_runs':runs}]))
 sys.exit(0)
raise RuntimeError('unexpected endpoint '+endpoint)
`;
const FAKE_SLEEP = `#!/bin/bash
# gh-retry.sh's request watchdog sleeps out its budget; keep that real.
if (($1 >= 50)); then exec /bin/sleep "$1"; fi
echo "$1" >> "$FAKE_ROOT/sleeps"
`;

const Call = v.object({
  method: v.string(),
  endpoint: v.string(),
  args: v.array(v.string()),
});
const State = v.object({ runs: v.array(v.object({ id: v.number() })) });

type Dispatch = {
  http: number | null;
  create?: boolean;
  visibleAfter?: number;
  after?: number;
};

const scenario = async (
  dispatches: Dispatch[],
  { listFails = false, settleSeconds = 30 } = {},
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "gh-dispatch-test-"));
  try {
    await writeFile(path.join(directory, "gh"), FAKE_GH);
    await writeFile(path.join(directory, "sleep"), FAKE_SLEEP);
    await chmod(path.join(directory, "gh"), 0o700);
    await chmod(path.join(directory, "sleep"), 0o700);
    // Runs that carried the title before the call never count as this one's.
    await writeFile(
      path.join(directory, "state.json"),
      JSON.stringify({
        posts: 0,
        lists: 0,
        runs: [
          { id: 7, display_title: TITLE, visible_from: 0 },
          { id: 8, display_title: "Main heavy suites other", visible_from: 0 },
        ],
      }),
    );
    const child = Bun.spawn(
      [
        "bash",
        HELPER,
        "example/project",
        "main-heavy.yml",
        "main",
        TITLE,
        "sha=abc123",
        "release_candidate=true",
      ],
      {
        env: {
          ...Bun.env,
          PATH: `${directory}:${Bun.env["PATH"] ?? ""}`,
          FAKE_ROOT: directory,
          FAKE_TITLE: TITLE,
          FAKE_DISPATCHES: JSON.stringify(dispatches),
          FAKE_LIST_FAILS: listFails ? "1" : "0",
          GH_DISPATCH_SETTLE_SECONDS: String(settleSeconds),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const calls = (await readFile(path.join(directory, "calls"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => v.parse(Call, JSON.parse(line)));
    const state = v.parse(
      State,
      JSON.parse(await readFile(path.join(directory, "state.json"), "utf-8")),
    );
    const sleepLog = path.join(directory, "sleeps");
    const sleeps = existsSync(sleepLog)
      ? (await readFile(sleepLog, "utf-8")).trim().split("\n")
      : [];
    expect(stdout + stderr).not.toContain("private-token-do-not-print");
    return {
      exit,
      stdout,
      stderr,
      posts: calls.filter((call) => call.method === "POST"),
      lists: calls.filter((call) => call.method === "GET"),
      created: state.runs.filter((run) => run.id >= 1000),
      sleeps,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("a 502 that created nothing is dispatched again and creates exactly one run", async () => {
  const result = await scenario([{ http: 502 }, { http: 204, create: true }]);

  expect(result.exit, result.stderr).toBe(0);
  expect(result.posts).toHaveLength(2);
  expect(result.created).toHaveLength(1);
  expect(result.posts.at(-1)?.endpoint).toBe(
    "/repos/example/project/actions/workflows/main-heavy.yml/dispatches",
  );
  expect(result.posts.at(-1)?.args).toEqual(
    expect.arrayContaining([
      "ref=main",
      "inputs[sha]=abc123",
      "inputs[release_candidate]=true",
    ]),
  );
  // The pre-existing run with the same title never stops the retry.
  expect(result.stderr).toContain("HTTP 502 (attempt 1/4)");
  expect(result.sleeps).toEqual(["5", "5", "5", "5", "5", "5"]);
  expect(result.lists.at(0)?.endpoint).toMatch(
    /\/runs\?event=workflow_dispatch&created=%3E%3D\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ&per_page=100$/u,
  );
});

test("a 502 whose run GitHub created anyway is never dispatched again", async () => {
  const result = await scenario([
    { http: 502, create: true, visibleAfter: 2 },
    { http: 204, create: true },
  ]);

  expect(result.exit, result.stderr).toBe(0);
  expect(result.posts).toHaveLength(1);
  expect(result.created).toHaveLength(1);
  expect(result.stdout).toContain(
    "GitHub created run 1001 for main-heavy.yml despite the failed response",
  );
});

test("a lost response is reconciled like a server error", async () => {
  const result = await scenario([{ http: null }, { http: 204, create: true }]);

  expect(result.exit, result.stderr).toBe(0);
  expect(result.stderr).toContain("no HTTP response (attempt 1/4)");
  expect(result.posts).toHaveLength(2);
  expect(result.created).toHaveLength(1);
});

test("persistent server errors fail after a bounded number of attempts", async () => {
  // One run-list read per attempt keeps the four attempts quick.
  const result = await scenario([{ http: 502 }], { settleSeconds: 0 });

  expect(result.exit).toBe(1);
  expect(result.posts).toHaveLength(4);
  expect(result.lists).toHaveLength(5);
  expect(result.created).toHaveLength(0);
  expect(result.stderr).toContain(
    `The main-heavy.yml dispatch failed 4 times (HTTP 502) and no '${TITLE}' run appeared within 0s of any attempt.`,
  );
});

test("a 422 fails at once without listing or dispatching again", async () => {
  const result = await scenario([{ http: 422 }]);

  expect(result.exit).toBe(1);
  expect(result.posts).toHaveLength(1);
  expect(result.lists).toHaveLength(1);
  expect(result.sleeps).toEqual([]);
  expect(result.stderr).toContain(
    "GitHub refused the main-heavy.yml dispatch with HTTP 422; it is not retried.",
  );
});

test("a 429 waits out Retry-After before dispatching again", async () => {
  const result = await scenario([
    { http: 429, after: 45 },
    { http: 204, create: true },
  ]);

  expect(result.exit, result.stderr).toBe(0);
  expect(result.posts).toHaveLength(2);
  expect(result.sleeps).toEqual(["5", "5", "5", "5", "5", "5", "15"]);
});

test("nothing is dispatched when the run list cannot be read first", async () => {
  const result = await scenario([{ http: 204, create: true }], {
    listFails: true,
  });

  expect(result.exit).toBe(1);
  expect(result.posts).toHaveLength(0);
  expect(result.stderr).toContain(
    "Could not list main-heavy.yml runs before dispatching; nothing was dispatched.",
  );
});

test("workflow dispatches go through the reconciling helper", () => {
  const root = path.resolve(import.meta.dir, "..");
  const files = [
    ...new Bun.Glob("{scripts,.github}/**/*.{sh,yml,yaml}").scanSync({
      cwd: root,
      dot: true,
    }),
  ].filter((file) => file !== "scripts/gh-dispatch-workflow.sh");
  const raw = files.filter((file) =>
    /gh-retry\.sh"?\s+api\s+(?:--method|-X)\s+POST\s+(?:\\\s*)?"?\/?repos\/[^\s"]*\/actions\/workflows\/[^\s"]+\/dispatches/u.test(
      readFileSync(path.join(root, file), "utf-8"),
    ),
  );
  expect(raw).toEqual([]);
});

test("release dispatch titles match the target workflows' run-names", () => {
  const workflows = path.resolve(import.meta.dir, "../.github/workflows");
  const source = (file: string) =>
    readFileSync(path.join(workflows, file), "utf-8");
  const release = source("release.yml");

  // Each title is the run-name the target renders for the same inputs.
  expect(source("main-heavy.yml")).toContain(
    `run-name: "Main heavy suites \${{ inputs.sha || github.sha }}"`,
  );
  expect(release).toContain(
    'gh-dispatch-workflow.sh "$GITHUB_REPOSITORY" main-heavy.yml main "Main heavy suites $SHA" "sha=$SHA"',
  );
  expect(source("main-pr-depth.yml")).toContain(
    `run-name: "Main PR-depth checks \${{ inputs.sha || github.sha }}"`,
  );
  expect(release).toContain(
    'gh-dispatch-workflow.sh "$GITHUB_REPOSITORY" main-pr-depth.yml main "Main PR-depth checks $SHA" "sha=$SHA"',
  );
  expect(source("deploy-staging.yml")).toContain(
    "format('Staging release proof {0} {1}', inputs.release_ref, inputs.sha || github.sha)",
  );
  expect(release).toContain(
    'gh-dispatch-workflow.sh "$GITHUB_REPOSITORY" deploy-staging.yml main "Staging release proof $RELEASE_REF $SHA" "sha=$SHA"',
  );
  expect(source("release-health.yml")).toContain(
    `run-name: Release health \${{ inputs.release_ref }}`,
  );
  expect(release).toContain(
    '"Release health $RELEASE_REF" "release_ref=$RELEASE_REF"',
  );
});
