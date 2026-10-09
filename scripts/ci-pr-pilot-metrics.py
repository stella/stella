"""Collect a bounded daily snapshot; uncertain evidence cannot enable the pilot."""

import argparse
import gzip
import re
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import time
import math
from zoneinfo import ZoneInfo

PROFILE = "pilot-v1"
WINDOW = dt.timedelta(days=7)
COMMIT_SAMPLE_LIMIT = 120
QUEUE_SAMPLE_LIMIT = 25
QUEUE_RUN_PAGE_LIMIT = 5
QUEUE_FAILURE_STOP = 2
RESULT_JOB = "ci-result"

def sample(values, limit):
    return values if len(values) <= limit else [values[int(index * (len(values) - 1) / (limit - 1))] for index in range(limit)]



def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    left = int(position)
    return ordered[left] + (ordered[min(left + 1, len(ordered) - 1)] - ordered[left]) * (position - left)


def summarize(pulls, start, end, fast_jobs):
    merged = []
    fanout_wait = []
    run_minutes = {}
    run_profiles = {}
    failures = set()
    seen_pulls = set()
    pending_arms = []
    seen_jobs = set()
    seen_runs = set()
    unfinished_runs = set()
    for pull in pulls:
        if pull["number"] in seen_pulls:
            continue
        seen_pulls.add(pull["number"])
        arms = [timestamp(event["createdAt"]) for event in pull["timelineItems"]["nodes"]
                if event["__typename"] in {"AutoMergeEnabledEvent", "AddedToMergeQueueEvent"}]
        merge = timestamp(pull["mergedAt"]) if pull["mergedAt"] else None
        # Include only observed arms: unarmed PRs are never zero-latency samples.
        first_arm = min(arms) if arms else None
        if first_arm and start <= first_arm < end:
            if merge and first_arm <= merge < end:
                merged.append((merge - first_arm).total_seconds() / 60)
            elif merge is None and pull.get("closedAt") is None:
                pending_arms.append((end - first_arm).total_seconds() / 60)
        for commit in pull["commits"]["nodes"]:
            for suite in commit["commit"].get("checkSuites", {"nodes": []})["nodes"]:
                run = suite["workflowRun"]
                if not run or run["event"] != "pull_request" or run["workflow"]["name"] != "CI Checks":
                    continue
                created = timestamp(suite["createdAt"])
                if not start <= created < end:
                    continue
                seen_runs.add(run["databaseId"])
                run_minutes.setdefault(run["databaseId"], 0.0)
                jobs = [job for job in suite["checkRuns"]["nodes"] if job["conclusion"] != "SKIPPED"]
                planner = next((job for job in jobs if job["name"] == "ci-plan"), None)
                annotations = planner.get("annotations", {"nodes": []})["nodes"] if planner else []
                profile_message = next((annotation["message"] for annotation in annotations
                                        if annotation["message"].startswith("coverage_profile=")), None)
                profile = {"coverage_profile=pilot-fast-v1": "fast",
                           "coverage_profile=normal-v1": "normal"}.get(profile_message, "unknown")
                run_profiles.setdefault(run["databaseId"], profile)
                # ci-result aggregates every job and runs last; until it completes,
                # later jobs may not exist yet, so the run's minutes are partial.
                result_done = any(job["name"] == RESULT_JOB and job["completedAt"] for job in jobs)
                if not result_done or any(not job["completedAt"] for job in jobs):
                    unfinished_runs.add(run["databaseId"])
                planner_end = next((timestamp(job["completedAt"]) for job in jobs
                                    if job["name"] == "ci-plan" and job["completedAt"]), None)
                starts = []
                for job in jobs:
                    if job["databaseId"] in seen_jobs:
                        continue
                    seen_jobs.add(job["databaseId"])
                    owner = job["name"].split(" (")[0]
                    if not job["startedAt"] or not job["completedAt"]:
                        continue
                    begin, finish = timestamp(job["startedAt"]), timestamp(job["completedAt"])
                    run_minutes[run["databaseId"]] += max(0, (finish - begin).total_seconds() / 60)
                    if owner not in {"ci-plan", "ci-result"}:
                        starts.append(begin)
                    if owner not in fast_jobs and job["conclusion"] == "FAILURE" and any(arm <= created for arm in arms):
                        failures.add((pull["number"], commit["commit"]["oid"]))
                if planner_end and starts:
                    fanout_wait.append(max(0, (min(starts) - planner_end).total_seconds() / 60))
    # In-flight runs have partial minutes; per-run figures use finished runs only.
    finished_minutes = {run_id: value for run_id, value in run_minutes.items() if run_id not in unfinished_runs}
    profile_totals = {
        profile: {
            "jobMinutes": sum(value for run_id, value in finished_minutes.items()
                              if run_profiles[run_id] == profile),
            "sampleCount": sum(run_profiles[run_id] == profile for run_id in finished_minutes),
        }
        for profile in ["fast", "normal", "unknown"]
    }
    minutes = sum(run_minutes.values())
    runs = len(seen_runs)
    finished_runs = len(finished_minutes)
    return {
        "jobMinutes": minutes, "runs": runs,
        "fastProfileJobMinutesPerPrRun": (profile_totals["fast"]["jobMinutes"] / profile_totals["fast"]["sampleCount"]
                                           if profile_totals["fast"]["sampleCount"] else None),
        "fastProfilePrRunSampleCount": profile_totals["fast"]["sampleCount"],
        "normalProfileJobMinutesPerPrRun": (profile_totals["normal"]["jobMinutes"] / profile_totals["normal"]["sampleCount"]
                                             if profile_totals["normal"]["sampleCount"] else None),
        "normalProfilePrRunSampleCount": profile_totals["normal"]["sampleCount"],
        "unknownProfileJobMinutesPerPrRun": (profile_totals["unknown"]["jobMinutes"] / profile_totals["unknown"]["sampleCount"]
                                              if profile_totals["unknown"]["sampleCount"] else None),
        "unknownProfilePrRunSampleCount": profile_totals["unknown"]["sampleCount"],
        "combinedJobMinutesPerPrRun": sum(finished_minutes.values()) / finished_runs if finished_runs else None,
        "combinedPrRunSampleCount": finished_runs,
        "unfinishedPrRunCount": len(unfinished_runs),
        "mergedSampleCount": len(merged),
        "armToMergeP50Minutes": percentile(merged, .5), "armToMergeP90Minutes": percentile(merged, .9),
        "pendingArmedSampleCount": len(pending_arms),
        "armToMergeP50LowerBoundMinutes": percentile(merged + pending_arms, .5),
        "runIds": sorted(seen_runs),
        "fanoutWaitP50Minutes": percentile(fanout_wait, .5), "fanoutWaitP90Minutes": percentile(fanout_wait, .9),
        "postArmDeferredFailureHeads": len(failures),
    }


def complete_pull(pull):
    connections = [pull["timelineItems"], pull["commits"]]
    for commit in pull["commits"]["nodes"]:
        if commit["commit"].get("sampled") is False:
            continue
        suites = commit["commit"]["checkSuites"]
        connections.append(suites)
        connections.extend(suite["checkRuns"] for suite in suites["nodes"] if suite["workflowRun"])
    return not any(connection["pageInfo"].get("hasNextPage", False) or connection["pageInfo"].get("hasPreviousPage", False) for connection in connections)


def build_report(pulls, previous, now, complete, fast_jobs, baseline, sampling, bootstrap=None):
    seed = previous or bootstrap
    if seed is None or seed.get("profile") != PROFILE:
        raise ValueError("A phase-3 bootstrap or previous report is required")
    started = timestamp(previous["startedAt"]) if previous else now
    baseline_p50 = seed["baselineArmToMergeP50Minutes"]
    baseline_runs = baseline["baselinePrRunSampleCount"]
    baseline_per_run = baseline["baselineJobMinutesPerPrRun"]
    for value in [baseline_p50, baseline_per_run]:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError("Invalid bootstrap metric")
    if isinstance(baseline_runs, bool) or not isinstance(baseline_runs, int) or baseline_runs <= 0:
        raise ValueError("Invalid bootstrap metric")
    measured = summarize(pulls, started, min(now, started + WINDOW), fast_jobs)
    complete = complete and baseline["baselineComplete"] and all(complete_pull(pull) for pull in pulls)
    stopped = bool(previous and previous["stopped"]) or now - started >= WINDOW
    for latency in [measured["armToMergeP50Minutes"], measured["armToMergeP50LowerBoundMinutes"]]:
        if latency is not None:
            stopped = stopped or latency > baseline_p50 + 20
    measured_per_run = measured["combinedJobMinutesPerPrRun"]
    return {
        "profile": PROFILE, "startedAt": started.astimezone(ZoneInfo("Europe/Prague")).isoformat(),
        "generatedAt": now.astimezone(ZoneInfo("Europe/Prague")).isoformat(),
        "complete": complete, "stopped": stopped, "baselineArmToMergeP50Minutes": baseline_p50,
        "baselineJobMinutesPerPrRun": baseline_per_run, "baselinePrRunSampleCount": baseline_runs,
        "baselineComplete": baseline["baselineComplete"],
        "baselineWindowStartedAt": baseline["baselineWindowStartedAt"],
        "baselineWindowEndedAt": baseline["baselineWindowEndedAt"],
        "armToMergeP50Minutes": measured["armToMergeP50Minutes"], "measured": measured,
        "estimatedWindowJobMinutesSaved": ((baseline_per_run - measured_per_run) * measured["runs"]
                                             * sampling["populationCommits"] / sampling["sampledCommits"]
                                             if measured_per_run is not None else 0),
        "estimateBasis": "(baseline per-run - pilot per-run) x observed sampled runs x populationCommits / sampledCommits",
    }


def measure_baseline(seed, collector, started, fast_jobs):
    fields = ["baselineJobMinutesPerPrRun", "baselinePrRunSampleCount",
              "baselineWindowStartedAt", "baselineWindowEndedAt", "baselineComplete"]
    if all(field in seed for field in fields) and seed["baselineComplete"]:
        return {field: seed[field] for field in fields}, True
    baseline_start = started - WINDOW
    pulls, complete = collector.collect(baseline_start, [])
    measured = summarize(pulls, baseline_start, started, fast_jobs)
    if measured["combinedJobMinutesPerPrRun"] is None:
        raise ValueError("Baseline window has no pull request CI runs")
    baseline = {
        "baselineJobMinutesPerPrRun": measured["combinedJobMinutesPerPrRun"],
        "baselinePrRunSampleCount": measured["combinedPrRunSampleCount"],
        "baselineWindowStartedAt": baseline_start.isoformat(),
        "baselineWindowEndedAt": started.isoformat(),
    }
    baseline["baselineComplete"] = (complete and measured["unfinishedPrRunCount"] == 0
                                    and all(complete_pull(pull) for pull in pulls))
    return baseline, baseline["baselineComplete"]


def apply_queue_failures(report, queue):
    report["measured"].update(queue)
    report["complete"] = report["complete"] and queue["queueFailureEvidenceComplete"]
    # Each deferred-check failure in the merge group ejects a PR and restarts
    # the queue for everyone; unattributed failures eject just the same.
    failures = queue["postArmDeferredQueueFailureHeads"] + queue["unmappedDeferredQueueFailureRuns"]
    report["stopped"] = report["stopped"] or failures >= QUEUE_FAILURE_STOP
    return report


class Collector:
    def __init__(self, repository):
        self.owner, self.repo = repository.split("/")
        self.last_request = 0.0
        self.sampling = {}

    def query(self, query, variables):
        time.sleep(max(0, 1.1 - (time.monotonic() - self.last_request)))
        self.last_request = time.monotonic()
        command = ["gh", "api", "graphql", "-f", f"query={query}"]
        for name, value in variables.items():
            if value is not None:
                command.extend(["-F" if isinstance(value, int) else "-f", f"{name}={value}"])
        response = subprocess.run(command, check=True, capture_output=True, timeout=30)
        data = json.loads(response.stdout)
        if data.get("errors"):
            raise ValueError("GraphQL evidence incomplete")
        return data["data"]

    def rest(self, endpoint, parameters):
        time.sleep(max(0, 1.1 - (time.monotonic() - self.last_request)))
        self.last_request = time.monotonic()
        command = ["gh", "api", "--method", "GET", f"repos/{self.owner}/{self.repo}/{endpoint}"]
        for name, value in parameters.items():
            command.extend(["-f", f"{name}={value}"])
        response = subprocess.run(command, check=True, capture_output=True, timeout=30)
        return json.loads(response.stdout)

    def queue_wait(self, run_ids):
        # Systematic samples span the whole generation and bound daily REST reads.
        selected = sample(run_ids, QUEUE_SAMPLE_LIMIT)
        waits = []
        pending = 0
        complete = True
        for run_id in selected:
            result = self.rest(f"actions/runs/{run_id}/jobs", {"per_page": 100, "filter": "latest"})
            complete = complete and result["total_count"] <= len(result["jobs"])
            for job in result["jobs"]:
                if job["conclusion"] == "skipped":
                    continue
                if not job.get("created_at"):
                    complete = False
                    continue
                if not job["started_at"]:
                    pending += 1
                    continue
                waits.append(max(0, (timestamp(job["started_at"]) - timestamp(job["created_at"])).total_seconds() / 60))
        return {"queueWaitP50Minutes": percentile(waits, .5), "queueWaitP90Minutes": percentile(waits, .9),
                "queueWaitSampledRuns": len(selected), "queueWaitPopulationRuns": len(run_ids),
                "queueWaitSampledJobs": len(waits), "queueWaitPendingJobs": pending,
                "queueWaitEvidenceComplete": complete}

    def queue_failures(self, since, normal_pr_deferred):
        heads = set()
        unmapped = 0
        complete = True
        runs = {}
        for conclusion in ["failure", "cancelled"]:
            seen = set()
            for page in range(1, QUEUE_RUN_PAGE_LIMIT + 1):
                result = self.rest("actions/workflows/ci.yml/runs", {
                    "event": "merge_group", "status": conclusion, "created": f">={since.isoformat()}",
                    "per_page": 100, "page": page,
                })
                for run in result["workflow_runs"]:
                    runs[run["id"]] = run
                    seen.add(run["id"])
                if len(seen) >= result["total_count"] or not result["workflow_runs"]:
                    break
            complete = complete and len(seen) >= result["total_count"]
        for run in runs.values():
            jobs = self.rest(f"actions/runs/{run['id']}/jobs", {"per_page": 100, "filter": "latest"})
            if jobs["total_count"] > len(jobs["jobs"]):
                complete = False
            failed = any(job["name"].split(" (")[0] in normal_pr_deferred
                         and job["conclusion"] == "failure" for job in jobs["jobs"])
            if not failed:
                continue
            pulls = run["pull_requests"]
            match = re.fullmatch(r"(?:refs/heads/)?gh-readonly-queue/[^/]+/pr-([0-9]+)-[0-9a-f]{40}",
                                 run.get("head_branch") or "")
            numbers = {pull["number"] for pull in pulls}
            if match:
                number = int(match.group(1))
                if numbers and numbers != {number}:
                    unmapped += 1
                    continue
                numbers.add(number)
            group_sha = run.get("head_sha") or ""
            if not numbers or not re.fullmatch(r"[0-9a-f]{40}", group_sha):
                unmapped += 1
                continue
            # Queue refs encode the base, not the PR head. Count the tested group
            # commit; a current PR lookup could attribute an old failure to a push.
            for number in numbers:
                heads.add((number, group_sha))
        return {"postArmDeferredQueueFailureHeads": len(heads),
                "unmappedDeferredQueueFailureRuns": unmapped, "queueFailureEvidenceComplete": complete and unmapped == 0}

    def collect(self, since, cached):
        pulls = {pull["number"]: pull for pull in cached}
        refreshed = set()
        cursor = None
        complete = True
        query = """query($owner:String!, $repo:String!, $cursor:String) {
          repository(owner:$owner,name:$repo) {
            pullRequests(first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}) {
              pageInfo {hasNextPage endCursor}
              nodes {number updatedAt mergedAt closedAt
                timelineItems(first:100,itemTypes:[AUTO_MERGE_ENABLED_EVENT,ADDED_TO_MERGE_QUEUE_EVENT,HEAD_REF_FORCE_PUSHED_EVENT]) {
                  pageInfo {hasNextPage} nodes {__typename ... on AutoMergeEnabledEvent {createdAt}
                    ... on AddedToMergeQueueEvent {createdAt}
                    ... on HeadRefForcePushedEvent {createdAt beforeCommit {oid} afterCommit {oid}}} }
                commits(last:100) {pageInfo {hasPreviousPage startCursor} nodes {commit {oid}}}
              }
            }
          }
        }"""
        for _ in range(30):
            result = self.query(query, {"owner": self.owner, "repo": self.repo, "cursor": cursor})
            page = result["repository"]["pullRequests"]
            for pull in page["nodes"]:
                if timestamp(pull["updatedAt"]) < since:
                    continue
                old = pulls.get(pull["number"])
                heads = {node["commit"]["oid"]: node for node in (old["commits"]["nodes"] if old else [])}
                for node in pull["commits"]["nodes"]:
                    heads.setdefault(node["commit"]["oid"], node)
                connection = pull["commits"]
                for _ in range(10):
                    if not connection["pageInfo"].get("hasPreviousPage", False):
                        break
                    result = self.query("""query($owner:String!, $repo:String!, $number:Int!, $before:String!) {
                      repository(owner:$owner,name:$repo) {pullRequest(number:$number) {
                        commits(last:100,before:$before) {pageInfo {hasPreviousPage startCursor} nodes {commit {oid}}}
                      }}
                    }""", {"owner": self.owner, "repo": self.repo, "number": pull["number"],
                           "before": connection["pageInfo"]["startCursor"]})
                    connection = result["repository"]["pullRequest"]["commits"]
                    for node in connection["nodes"]:
                        heads.setdefault(node["commit"]["oid"], node)
                if connection["pageInfo"].get("hasPreviousPage", False):
                    complete = False
                pull["commits"]["pageInfo"] = connection["pageInfo"]
                for event in pull["timelineItems"]["nodes"]:
                    for key in ["beforeCommit", "afterCommit"]:
                        if event.get(key):
                            sha = event[key]["oid"]
                            heads.setdefault(sha, {"commit": {"oid": sha}})
                pull["commits"]["nodes"] = list(heads.values())
                pulls[pull["number"]] = pull
                refreshed.add(pull["number"])
            if not page["pageInfo"]["hasNextPage"] or any(timestamp(pull["updatedAt"]) < since for pull in page["nodes"]):
                break
            cursor = page["pageInfo"]["endCursor"]
        else:
            complete = False
        population = sorted({node["commit"]["oid"] for pull in pulls.values() for node in pull["commits"]["nodes"]})
        selected = set(sample(population, COMMIT_SAMPLE_LIMIT))
        self.sampling = {"sampledCommits": len(selected), "populationCommits": len(population)}
        pending = set()
        for pull in pulls.values():
            for node in pull["commits"]["nodes"]:
                commit = node["commit"]
                commit["sampled"] = commit["oid"] in selected
                if not commit["sampled"]:
                    commit.pop("checkSuites", None)
                    continue
                suites = commit.get("checkSuites")
                active = suites and any(job["completedAt"] is None
                    for suite in suites["nodes"] for job in suite["checkRuns"]["nodes"])
                if pull["number"] in refreshed or suites is None or active:
                    pending.add(commit["oid"])
        shas = sorted(pending)
        # Sample workload reads; every PR timeline still participates in the stop metric.
        responses = {}
        for index in range(0, len(shas), 5):
            batch = shas[index:index + 5]
            if any(re.fullmatch(r"[a-f0-9]{40}", sha) is None for sha in batch):
                raise ValueError("Invalid commit identity")
            variables = {"owner": self.owner, "repo": self.repo}
            declarations = ["$owner:String!", "$repo:String!"]
            fields = []
            for offset, sha in enumerate(batch):
                variables[f"sha{offset}"] = sha
                declarations.append(f"$sha{offset}:String!")
                fields.append(f"head{offset}:object(expression:$sha{offset}) {{... on Commit {{oid checkSuites(first:100) {{pageInfo {{hasNextPage}} nodes {{createdAt workflowRun {{databaseId event workflow {{name}}}} checkRuns(first:100) {{pageInfo {{hasNextPage}} nodes {{databaseId name startedAt completedAt conclusion annotations(first:5) {{nodes {{message}}}}}}}}}}}}}}}}")
            result = self.query("query(" + ",".join(declarations) + "){repository(owner:$owner,name:$repo){" + " ".join(fields) + "}}", variables)
            for offset, sha in enumerate(batch):
                value = result["repository"][f"head{offset}"]
                if not value:
                    complete = False
                    continue
                responses[sha] = value["checkSuites"]
        for pull in pulls.values():
            for node in pull["commits"]["nodes"]:
                commit = node["commit"]
                if commit["oid"] in responses:
                    commit["checkSuites"] = responses[commit["oid"]]
                if commit["sampled"] and "checkSuites" not in commit:
                    complete = False
                    commit["checkSuites"] = {"pageInfo": {"hasNextPage": True}, "nodes": []}
        return list(pulls.values()), complete


def write_report(filename, report):
    target = Path(filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2) + "\n")
    os.chmod(target, 0o600)


def write_evidence(args, report, pulls):
    cache_output = Path(args.cache_output)
    cache_output.parent.mkdir(parents=True, exist_ok=True)
    cache_output.write_bytes(gzip.compress(json.dumps(pulls).encode()))
    os.chmod(cache_output, 0o600)
    write_report(args.output, report)
    if args.private_output:
        write_report(args.private_output, report)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--private-output")
    parser.add_argument("--previous")
    parser.add_argument("--bootstrap")
    parser.add_argument("--cache")
    parser.add_argument("--cache-output", required=True)
    args = parser.parse_args()
    now = dt.datetime.now(dt.UTC)
    previous = json.loads(Path(args.previous).read_text()) if args.previous and Path(args.previous).exists() else None
    if previous and previous["profile"] != PROFILE:
        raise ValueError("Unrecognized previous pilot generation")
    bootstrap = json.loads(Path(args.bootstrap).read_text()) if args.bootstrap and Path(args.bootstrap).exists() else None
    cached = json.loads(gzip.decompress(Path(args.cache).read_bytes())) if args.cache and Path(args.cache).exists() else []
    if previous and previous["stopped"] and bootstrap is None:
        previous["generatedAt"] = now.astimezone(ZoneInfo("Europe/Prague")).isoformat()
        write_evidence(args, previous, cached)
        print("Pilot generation remains stopped; final metrics retained")
        return
    start = timestamp(previous["startedAt"]) if previous else now
    since = max(start, timestamp(previous["generatedAt"]) - dt.timedelta(hours=1)) if previous and cached else start
    collector = Collector(args.repository)
    plan = subprocess.run(["bun", "scripts/ci-pr-pilot-plan.ts", ".github/workflows/ci.yml"],
                          check=True, capture_output=True, text=True)
    fast_jobs = set(json.loads(plan.stdout.removeprefix("fast_jobs=")))
    seed = previous or bootstrap
    baseline, baseline_complete = measure_baseline(seed, collector, start, fast_jobs)
    pulls, complete = collector.collect(since, cached)
    sampling = collector.sampling
    report = build_report(pulls, previous, now, complete and baseline_complete, fast_jobs,
                          baseline, sampling, bootstrap)
    report["measured"].update(collector.sampling)
    report["measured"]["jobMinutesBasis"] = "observed systematic commit sample"
    waiting = collector.queue_wait(report["measured"].pop("runIds"))
    report["measured"].update(waiting)
    report["complete"] = report["complete"] and waiting["queueWaitEvidenceComplete"]
    policy = json.loads(Path(".github/ci-event-policy.json").read_text())["jobs"]
    normal_pr_deferred = {name.removeprefix("ci.yml/") for name, category in policy.items()
                          if name.startswith("ci.yml/") and category in {"pr-fast", "pr-opt-in", "schema-pr", "release-pr"}
                          and name.removeprefix("ci.yml/") not in fast_jobs}
    queue = collector.queue_failures(start, normal_pr_deferred)
    apply_queue_failures(report, queue)
    report["postArmCycleDefinition"] = "distinct observed PR heads and tested merge-group commits failing normal-PR checks deferred by pilot-fast; unmapped runs are reported separately"
    write_evidence(args, report, pulls)
    print(f"Pilot metrics complete={report['complete']} stopped={report['stopped']}")


if __name__ == "__main__":
    main()
