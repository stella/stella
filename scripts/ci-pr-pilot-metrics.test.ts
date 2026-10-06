import { expect, test } from "bun:test";
import { Script } from "node:vm";
import * as v from "valibot";

const execute = (body: string) => {
  const result = Bun.spawnSync([
    "python3",
    "-c",
    `
import datetime as dt, importlib.util, json
spec = importlib.util.spec_from_file_location("metrics", "scripts/ci-pr-pilot-metrics.py")
if spec is None or spec.loader is None:
    raise RuntimeError("Missing metrics module")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
now = dt.datetime(2026, 10, 10, 12, tzinfo=dt.UTC)
seed = {"profile": "pilot-v1", "baselineArmToMergeP50Minutes": 10, "baselineJobMinutesPerDay": 100}
${body}
`,
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
};

test("metrics preserve a stop across generations and expire after one week", () => {
  const values = execute(`
initial = m.build_report([], None, now, True, set(), seed)
latched = dict(initial, stopped=True)
continued = m.build_report([], latched, now + dt.timedelta(days=1), True, set())
expired = m.build_report([], initial, now + dt.timedelta(days=7), True, set())
print(json.dumps([initial["stopped"], continued["stopped"], expired["stopped"], continued["startedAt"] == initial["startedAt"]]))
`);
  expect(values).toEqual([false, true, true, true]);
});

test("metrics separate runner queue wait, fan-out delay and actual job minutes", () => {
  const result = execute(`
def connection(nodes):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": False}}
run = {"databaseId": 1, "event": "pull_request", "workflow": {"name": "CI Checks"}}
jobs = [
 {"databaseId": 1, "name": "ci-plan", "conclusion": "SUCCESS", "createdAt": "2026-10-10T10:00:00Z", "startedAt": "2026-10-10T10:02:00Z", "completedAt": "2026-10-10T10:03:00Z"},
 {"databaseId": 2, "name": "ci-tests (rest-web)", "conclusion": "SUCCESS", "createdAt": "2026-10-10T10:03:00Z", "startedAt": "2026-10-10T10:17:00Z", "completedAt": "2026-10-10T10:19:00Z"},
]
suite = {"createdAt": "2026-10-10T10:00:00Z", "workflowRun": run, "checkRuns": connection(jobs)}
pull = {"number": 1, "mergedAt": "2026-10-10T11:00:00Z", "timelineItems": connection([
 {"__typename": "AutoMergeEnabledEvent", "createdAt": "2026-10-10T10:30:00Z"}]),
 "commits": connection([{"commit": {"oid": "head", "checkSuites": connection([suite])}}])}
start = dt.datetime(2026, 10, 10, tzinfo=dt.UTC)
class Fixture(m.Collector):
    def rest(self, endpoint, parameters):
        return {"total_count": len(jobs), "jobs": [{"conclusion": "success", "created_at": job["createdAt"],
            "started_at": job["startedAt"]} for job in jobs]}
summary = m.summarize([pull, pull], start, now, {"ci-tests"})
summary.update(Fixture("stella/stella").queue_wait(summary.pop("runIds")))
print(json.dumps(summary))
`);
  const report = v.parse(
    v.object({
      jobMinutes: v.number(),
      runs: v.number(),
      armToMergeP50Minutes: v.number(),
      queueWaitP50Minutes: v.number(),
      queueWaitP90Minutes: v.number(),
      fanoutWaitP50Minutes: v.number(),
    }),
    result,
  );
  expect(report.jobMinutes).toBe(3);
  expect(report.runs).toBe(1);
  expect(report.armToMergeP50Minutes).toBe(30);
  expect(report.queueWaitP50Minutes).toBe(8);
  expect(report.queueWaitP90Minutes).toBeCloseTo(12.8);
  expect(report.fanoutWaitP50Minutes).toBe(14);
});

test("missing bootstrap and incomplete pagination cannot certify an optimization", () => {
  const values = execute(`
try:
    m.build_report([], None, now, True, set())
except ValueError:
    missing = True
else:
    missing = False
partial = m.build_report([], None, now, False, set(), seed)
print(json.dumps([missing, partial["complete"]]))
`);
  expect(values).toEqual([true, false]);
});

test("a queue miss is counted only for normal PR checks deferred by the pilot", () => {
  const values = execute(`
class Fixture(m.Collector):
    def rest(self, endpoint, parameters):
        if endpoint.endswith("/runs"):
            return {"total_count": 2, "workflow_runs": [
                {"id": 1, "head_sha": "a" * 40, "pull_requests": [{"number": 1, "head": {"sha": "head"}}]},
                {"id": 2, "pull_requests": []},
            ]}
        return {"total_count": 1, "jobs": [{"name": "parser-version-guard", "conclusion": "failure"}]}
result = Fixture("stella/stella").queue_failures(now, {"parser-version-guard"})
fast = Fixture("stella/stella").queue_failures(now, set())
print(json.dumps([result["postArmDeferredQueueFailureHeads"], result["unmappedDeferredQueueFailureRuns"],
                  result["queueFailureEvidenceComplete"], fast["postArmDeferredQueueFailureHeads"]]))
`);
  expect(values).toEqual([1, 1, false, 0]);
});

test("queue failure evidence includes cancelled runs and maps the tested group commit", () => {
  const values = execute(`
class Fixture(m.Collector):
    def __init__(self, truncated=False):
        super().__init__("stella/stella")
        self.truncated = truncated
        self.reads = []
    def rest(self, endpoint, parameters):
        self.reads.append([endpoint, parameters])
        if endpoint.endswith("/runs"):
            runs = [] if parameters["status"] == "failure" else [
                {"id": 1, "pull_requests": [], "head_sha": "a" * 40,
                 "head_branch": "gh-readonly-queue/main/pr-42-" + "b" * 40},
                {"id": 2, "pull_requests": [], "head_sha": "a" * 40,
                 "head_branch": "refs/heads/gh-readonly-queue/main/pr-42-" + "b" * 40},
                {"id": 3, "pull_requests": [], "head_sha": "c" * 40,
                 "head_branch": "gh-readonly-queue/main/pr-42-" + "b" * 40},
                {"id": 4, "pull_requests": [], "head_sha": "d" * 40,
                 "head_branch": "gh-readonly-queue/main/pr-43-" + "b" * 40},
            ]
            return {"total_count": len(runs) + int(self.truncated), "workflow_runs": runs}
        conclusion = "cancelled" if endpoint == "actions/runs/4/jobs" else "failure"
        return {"total_count": 1, "jobs": [{"name": "parser-version-guard", "conclusion": conclusion}]}
fixture = Fixture()
result = fixture.queue_failures(now, {"parser-version-guard"})
partial = Fixture(True).queue_failures(now, {"parser-version-guard"})
print(json.dumps([result, partial["queueFailureEvidenceComplete"],
                  [parameters["status"] for endpoint, parameters in fixture.reads if endpoint.endswith("/runs")]]))
`);
  expect(values).toEqual([
    {
      postArmDeferredQueueFailureHeads: 2,
      unmappedDeferredQueueFailureRuns: 0,
      queueFailureEvidenceComplete: true,
    },
    false,
    ["failure", "cancelled"],
  ]);
});

test("ambiguous queue associations cannot certify failure evidence", () => {
  const values = execute(`
class Fixture(m.Collector):
    def rest(self, endpoint, parameters):
        if endpoint.endswith("/runs"):
            return {"total_count": 3, "workflow_runs": [
                {"id": 1, "pull_requests": [{"number": 7, "head": {"sha": "later-head"}}], "head_sha": "a" * 40,
                 "head_branch": "gh-readonly-queue/main/pr-42-" + "b" * 40},
                {"id": 2, "pull_requests": [], "head_sha": "c" * 40, "head_branch": "unknown"},
                {"id": 3, "pull_requests": [], "head_sha": "invalid",
                 "head_branch": "gh-readonly-queue/main/pr-42-" + "b" * 40},
            ]}
        return {"total_count": 1, "jobs": [{"name": "parser-version-guard", "conclusion": "failure"}]}
print(json.dumps(Fixture("stella/stella").queue_failures(now, {"parser-version-guard"})))
`);
  expect(values).toEqual({
    postArmDeferredQueueFailureHeads: 0,
    unmappedDeferredQueueFailureRuns: 3,
    queueFailureEvidenceComplete: false,
  });
});

test("only a p50 increase greater than twenty minutes stops a generation", () => {
  const values = execute(`
def connection(nodes):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": False}}
def pull(minutes):
    return {"number": 1, "mergedAt": (now - dt.timedelta(hours=1) + dt.timedelta(minutes=minutes)).isoformat(),
        "timelineItems": connection([{"__typename": "AutoMergeEnabledEvent", "createdAt": (now - dt.timedelta(hours=1)).isoformat()}]),
        "commits": connection([])}
initial = m.build_report([], None, now - dt.timedelta(days=1), True, set(), seed)
exact = m.build_report([pull(30)], initial, now, True, set())
over = m.build_report([pull(30.01)], initial, now, True, set())
print(json.dumps([exact["stopped"], over["stopped"]]))
`);
  expect(values).toEqual([false, true]);
});

test("daily collection retains replaced heads and batches resolved commits five at a time", () => {
  const values = execute(`
def connection(nodes):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": False}}
old = "a" * 40
new = "b" * 40
cached = [{"number": 1, "updatedAt": now.isoformat(), "mergedAt": None,
    "timelineItems": connection([]), "commits": connection([
        {"commit": {"oid": old, "checkSuites": connection([])}}])}]
class Fixture(m.Collector):
    def __init__(self):
        super().__init__("stella/stella")
        self.batches = []
    def query(self, query, variables):
        if "pullRequests(" in query:
            return {"repository": {"pullRequests": dict(connection([
                {"number": 1, "updatedAt": now.isoformat(), "mergedAt": None,
                 "timelineItems": connection([{"__typename": "HeadRefForcePushedEvent",
                    "createdAt": now.isoformat(), "beforeCommit": {"oid": old}, "afterCommit": {"oid": new}}]),
                 "commits": connection([{"commit": {"oid": new}}])}
            ]), pageInfo={"hasNextPage": False, "endCursor": None})}}
        shas = [value for key, value in variables.items() if key.startswith("sha")]
        self.batches.append(shas)
        return {"repository": {"head" + str(index): {"oid": sha, "checkSuites": connection([])}
            for index, sha in enumerate(shas)}}
fixture = Fixture()
pulls, complete = fixture.collect(now - dt.timedelta(hours=1), cached)
print(json.dumps([complete, sorted(node["commit"]["oid"] for node in pulls[0]["commits"]["nodes"]),
                  fixture.batches, m.complete_pull(pulls[0])]))
`);
  expect(values).toEqual([
    true,
    ["a".repeat(40), "b".repeat(40)],
    [["a".repeat(40), "b".repeat(40)]],
    true,
  ]);
});

test("commit lookup is bounded and missing objects make daily evidence incomplete", () => {
  const values = execute(`
def connection(nodes):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": False}}
class Fixture(m.Collector):
    def __init__(self, count, missing=False):
        super().__init__("stella/stella")
        self.count, self.missing, self.batch_sizes = count, missing, []
    def query(self, query, variables):
        if "pullRequests(" in query:
            nodes = [{"number": 1, "updatedAt": now.isoformat(), "mergedAt": now.isoformat(),
                "timelineItems": connection([{ "__typename": "AutoMergeEnabledEvent", "createdAt": (now - dt.timedelta(minutes=30)).isoformat()}]), "commits": connection([
                    {"commit": {"oid": format(index, "040x")}} for index in range(self.count)])}]
            return {"repository": {"pullRequests": dict(connection(nodes), pageInfo={"hasNextPage": False, "endCursor": None})}}
        shas = [value for key, value in variables.items() if key.startswith("sha")]
        self.batch_sizes.append(len(shas))
        return {"repository": {"head" + str(index): None if self.missing else {"checkSuites": connection([])}
            for index, sha in enumerate(shas)}}
normal = Fixture(11)
_, complete = normal.collect(now, [])
missing = Fixture(1, True)
missing_pulls, missing_complete = missing.collect(now, [])
over = Fixture(601)
over_pulls, over_complete = over.collect(now, [])
print(json.dumps([complete, normal.batch_sizes, missing_complete, m.complete_pull(missing_pulls[0]),
                  over_complete, sum(over.batch_sizes), max(over.batch_sizes), m.complete_pull(over_pulls[0]), over.sampling["populationCommits"],
                  m.summarize(over_pulls, now - dt.timedelta(days=1), now + dt.timedelta(seconds=1), set())["armToMergeP50Minutes"]]))
`);
  expect(values).toEqual([
    true,
    [5, 5, 1],
    false,
    false,
    true,
    120,
    5,
    true,
    601,
    30,
  ]);
});

test("closed unmerged PRs cannot inflate pending arm latency", () => {
  const result = execute(`
pull = {"number": 1, "mergedAt": None, "closedAt": now.isoformat(),
    "timelineItems": {"nodes": [{"__typename": "AutoMergeEnabledEvent",
        "createdAt": (now - dt.timedelta(hours=4)).isoformat()}]}, "commits": {"nodes": []}}
summary = m.summarize([pull], now - dt.timedelta(days=1), now, set())
print(json.dumps([summary["pendingArmedSampleCount"], summary["armToMergeP50LowerBoundMinutes"]]))
`);
  expect(result).toEqual([0, null]);
});

test("queue-wait sampling bounds reads and reports the full run population", () => {
  const values = execute(`
class Fixture(m.Collector):
    def __init__(self):
        super().__init__("stella/stella")
        self.ids = []
    def rest(self, endpoint, parameters):
        self.ids.append(int(endpoint.split("/")[2]))
        return {"total_count": 1, "jobs": [{"conclusion": "success",
            "created_at": "2026-10-10T10:00:00Z", "started_at": "2026-10-10T10:02:00Z"}]}
fixture = Fixture()
result = fixture.queue_wait(list(range(1000)))
print(json.dumps([len(fixture.ids), fixture.ids[0], fixture.ids[-1], result["queueWaitPopulationRuns"],
    result["queueWaitP50Minutes"], result["queueWaitEvidenceComplete"]]))
`);
  expect(values).toEqual([25, 0, 999, 1000, 2, true]);
});

test("large PR commit connections are paginated before workload sampling", () => {
  const values = execute(`
def connection(nodes):
    return {"nodes": nodes, "pageInfo": {"hasPreviousPage": False}}
class Fixture(m.Collector):
    def query(self, query, variables):
        if "pullRequests(" in query:
            pull = {"number": 1, "updatedAt": now.isoformat(), "mergedAt": None,
                "timelineItems": connection([]), "commits": connection([{"commit": {"oid": "b" * 40}}])}
            pull["commits"]["pageInfo"] = {"hasPreviousPage": True, "startCursor": "before"}
            return {"repository": {"pullRequests": {"nodes": [pull], "pageInfo": {"hasNextPage": False}}}}
        if "pullRequest(number:" in query:
            assert variables["before"] == "before"
            return {"repository": {"pullRequest": {"commits": connection([{"commit": {"oid": "a" * 40}}])}}}
        return {"repository": {"head" + str(index): {"checkSuites": connection([])}
            for index in range(len([key for key in variables if key.startswith("sha")]))}}
pulls, complete = Fixture("stella/stella").collect(now, [])
print(json.dumps([complete, len(pulls[0]["commits"]["nodes"]), m.complete_pull(pulls[0])]))
`);
  expect(values).toEqual([true, 2, true]);
});

test("integer GraphQL variables keep their numeric type at the gh boundary", () => {
  const values = execute(`
from types import SimpleNamespace
calls = []
def run(command, **kwargs):
    calls.append(command)
    return SimpleNamespace(stdout=b'{"data": {}}')
m.subprocess.run = run
m.Collector("stella/stella").query("query($number:Int!){viewer{login}}", {"number": 1})
index = calls[0].index("number=1")
print(json.dumps(calls[0][index - 1]))
`);
  expect(values).toBe("-F");
});

test("a stopped generation CLI publishes both evidence artifacts and retains its cache", () => {
  const values = execute(`
import gzip, os, subprocess, sys, tempfile
from pathlib import Path
results = []
for has_cache in [True, False]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        previous = dict(m.build_report([], None, now, True, set(), seed), stopped=True)
        previous_path = root / "previous.json"
        previous_path.write_text(json.dumps(previous))
        cached = [{"number": 73, "commits": {"nodes": []}}] if has_cache else []
        cache_path = root / "previous.json.gz"
        if has_cache:
            cache_path.write_bytes(gzip.compress(json.dumps(cached).encode()))
        output = root / "public" / "report.json"
        private = root / "private" / "report.json"
        cache_output = root / "cache" / "report.json.gz"
        result = subprocess.run([sys.executable, "scripts/ci-pr-pilot-metrics.py",
            "--repository", "stella/stella", "--previous", str(previous_path),
            "--cache", str(cache_path), "--output", str(output),
            "--private-output", str(private), "--cache-output", str(cache_output)],
            check=True, capture_output=True, text=True, env={"PATH": ""})
        report = json.loads(output.read_text())
        preserved = json.loads(gzip.decompress(cache_output.read_bytes())) if cache_output.exists() else None
        results.append([report["stopped"], report["startedAt"] == previous["startedAt"],
            report["generatedAt"] != previous["generatedAt"], json.loads(private.read_text()) == report,
            preserved == cached, [os.stat(p).st_mode & 0o777 for p in [output, private, cache_output]]
                if cache_output.exists() else [], "remains stopped" in result.stdout])
print(json.dumps(results))
`);
  expect(values).toEqual([
    [true, true, true, true, true, [0o600, 0o600, 0o600], true],
    [true, true, true, true, true, [0o600, 0o600, 0o600], true],
  ]);
});

test("metrics workflow gets the default branch without schedule or dispatch repository payloads", async () => {
  const workflow = v.parse(
    v.object({
      jobs: v.object({
        metrics: v.object({
          steps: v.array(
            v.looseObject({
              name: v.string(),
              with: v.optional(
                v.looseObject({ script: v.optional(v.string()) }),
              ),
            }),
          ),
        }),
      }),
    }),
    Bun.YAML.parse(
      await Bun.file(
        new URL(
          "../.github/workflows/ci-pr-pilot-metrics.yml",
          import.meta.url,
        ),
      ).text(),
    ),
  );
  const scripts = workflow.jobs.metrics.steps.filter(
    (step) => step.with?.script !== undefined,
  );
  expect(scripts).toHaveLength(1);
  for (const step of scripts) {
    const script = step.with?.script;
    if (script === undefined) {
      throw new Error("Missing metrics workflow script");
    }
    for (const eventName of ["schedule", "workflow_dispatch"]) {
      for (const head_branch of ["trunk", "untrusted"]) {
        const outputs = new Map<string, string>();
        const calls: string[] = [];
        const repo = { owner: "stella", repo: "stella" };
        await new Script(`(async () => {${script}\n})()`).runInNewContext({
          context: {
            repo,
            runId: 100,
            eventName,
            payload:
              eventName === "schedule"
                ? { schedule: "37 3 * * *" }
                : { inputs: {} },
          },
          setTimeout: (callback: () => void) => callback(),
          core: {
            setOutput: (key: string, value: string) => outputs.set(key, value),
          },
          github: {
            rest: {
              repos: {
                get: async (request: { owner: string; repo: string }) => {
                  expect(request.owner).toBe(repo.owner);
                  expect(request.repo).toBe(repo.repo);
                  calls.push("repository");
                  return { data: { default_branch: "trunk" } };
                },
              },
              actions: {
                listArtifactsForRepo: async () => ({
                  data: {
                    artifacts: [
                      {
                        id: 10,
                        name: "ci-pr-depth-pilot-v1",
                        expired: false,
                        workflow_run: { id: 99, head_sha: "abc" },
                      },
                    ],
                  },
                }),
                getWorkflowRun: async () => ({
                  data: {
                    id: 99,
                    path: ".github/workflows/ci-pr-pilot-metrics.yml",
                    event: eventName,
                    head_branch,
                    head_sha: "abc",
                    status: "completed",
                    conclusion: "success",
                  },
                }),
              },
            },
          },
        });
        expect(calls).toEqual(["repository"]);
        expect(outputs.get("run_id")).toBe(
          head_branch === "trunk" ? "99" : undefined,
        );
      }
    }
  }
});
