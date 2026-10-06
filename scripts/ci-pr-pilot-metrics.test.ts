import { expect, test } from "bun:test";
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
                {"id": 1, "pull_requests": [{"number": 1, "head": {"sha": "head"}}]},
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
            nodes = [{"number": 1, "updatedAt": now.isoformat(), "mergedAt": None,
                "timelineItems": connection([]), "commits": connection([
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
                  over_complete, sum(over.batch_sizes), max(over.batch_sizes), m.complete_pull(over_pulls[0])]))
`);
  expect(values).toEqual([true, [5, 5, 1], false, false, false, 600, 5, false]);
});
