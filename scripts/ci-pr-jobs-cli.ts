#!/usr/bin/env bun

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { prDepthJobs, prHeavyJobs, WorkflowPlanError } from "./ci-pr-jobs";

const runnerTemp = Bun.env["RUNNER_TEMP"];
const output = Bun.env["GITHUB_OUTPUT"];
if (!runnerTemp || !output) {
  throw new WorkflowPlanError("RUNNER_TEMP and GITHUB_OUTPUT are required");
}

const workflow: unknown = Bun.YAML.parse(
  readFileSync(path.join(runnerTemp, "ci-workflow.yml"), "utf-8"),
);
appendFileSync(
  output,
  `pr_depth_jobs=${JSON.stringify(prDepthJobs(workflow))}\npr_heavy_jobs=${JSON.stringify(prHeavyJobs(workflow))}\n`,
);
