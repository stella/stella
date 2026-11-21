import { isDeepStrictEqual } from "node:util";

/** The workflow that cancels a run once the job that failed it has ended. */
export const CANCEL_AFTER_JOB_WORKFLOW = "cancel-failed-run.yml";

// A run cancelled while the failing job is still running marks that job
// cancelled too, so the failure would read as a cancellation. A job that failed
// itself (its job.status, passed in as JOB_STATUS, is "failure") therefore hands
// the cancellation to a dispatched run, which waits for this job to end and
// then cancels the rest; the job keeps its failure conclusion. A runner runs one
// job at a time, so its name identifies this job's record. The jobs API can lag
// behind the step that failed this job, so the job's own status decides, and
// the annotation names the job while its failed step is not listed yet. A
// helper job (the failed job has already ended), a job whose record is not
// found, or a refused dispatch cancels the run here at once. A lost runner
// leaves a failed job whose step ended cancelled (or that never ran a step);
// when no step failed and this job did not fail itself, the run continues.
export const CANCEL_FAILURE_SCRIPT = `let diagnostic;
let failureSummary = "failed-step lookup unavailable";
let evidenceTimer;
let ownJob;
const failedHere = process.env.JOB_STATUS === "failure";
const failed = (step) => step.conclusion === "failure";
try {
  const jobs = await Promise.race([
    github.paginate(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
      {
        ...context.repo,
        run_id: context.runId,
        attempt_number: Number(process.env.GITHUB_RUN_ATTEMPT),
        per_page: 100,
        request: { timeout: 10000 },
      },
    ),
    new Promise((_, reject) => {
      evidenceTimer = setTimeout(() => reject(new Error("Failed-step lookup timed out")), 10000);
    }),
  ]);
  ownJob = jobs.find((job) => job.status === "in_progress" && job.runner_name === process.env.RUNNER_NAME);
  const failures = jobs.flatMap((job) => (job.steps || [])
    .filter(failed)
    .map((step) => \`\${job.name} / \${step.number}: \${step.name} (\${job.html_url})\`));
  if (failedHere && !ownJob?.steps?.some(failed)) failures.push(\`\${ownJob?.name || context.job}: failed step not yet listed\`);
  const lost = jobs.filter((job) => job.conclusion === "failure"
    && !(job.steps || []).some(failed)
    && (job.steps || []).every((step) => !step.status || step.status === "completed")
    && (!(job.steps || []).length || job.steps.some((step) => step.conclusion === "cancelled")));
  if (!failures.length && lost.length) {
    core.notice(\`\${lost.map((job) => job.name).join(", ")}: the runner was lost before any step failed; the run continues.\`);
    return;
  }
  failureSummary = failures.length ? failures.join("; ") : "failed steps not yet available from the jobs API";
  diagnostic = \`\${context.job}: cancelling failed merge group; failed steps: \${failures.length ? failures.join("; ") : "not yet available from the jobs API"}\`;
} catch {
  diagnostic = \`\${context.job}: cancelling failed merge group; failed-step lookup unavailable\`;
} finally {
  clearTimeout(evidenceTimer);
}
core.error(diagnostic);
try {
  core.summary.addRaw(\`Merge group failed: \${failureSummary}. Other jobs were cancelled to free runners.\\n\${diagnostic}\\n\`);
  await core.summary.write();
} catch {
  core.error(\`\${context.job}: cancellation step summary could not be written\`);
}
if (ownJob && (failedHere || ownJob.steps?.some(failed))) {
  try {
    await github.rest.actions.createWorkflowDispatch({
      ...context.repo,
      workflow_id: "${CANCEL_AFTER_JOB_WORKFLOW}",
      ref: "main",
      inputs: { run_id: String(context.runId), run_attempt: process.env.GITHUB_RUN_ATTEMPT, job_id: String(ownJob.id) },
    });
    core.notice(\`\${context.job}: the run is cancelled once this job ends, so this job keeps its failure conclusion.\`);
    return;
  } catch {
    core.error(\`\${context.job}: the cancellation could not be handed off; cancelling the run now.\`);
  }
}
await github.rest.actions.cancelWorkflowRun({
  ...context.repo,
  run_id: context.runId,
});
`;

export const CANONICAL_CANCEL_STEP = {
  name: "Cancel merge group after failure in this job",
  uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
  // The job's own status: "failure" once one of its steps has failed.
  env: { JOB_STATUS: `\${{ job.status }}` },
  with: {
    retries: 0,
    script: CANCEL_FAILURE_SCRIPT,
  },
} as const;

export const isCanonicalFailureCancellation = (step: unknown) =>
  isDeepStrictEqual(step, {
    ...CANONICAL_CANCEL_STEP,
    if: "failure() && github.event_name == 'merge_group'",
  });

// Lint and typecheck failures are the commonest reason a pull request run
// fails, and every other job's result is moot once one is found. The code
// quality jobs therefore stop the rest of a failed pull request run too,
// freeing its runners, with the same failed-step evidence. Fork pull
// requests get a read-only token that cannot cancel the run, so they skip it.
export const PR_CODE_QUALITY_CANCEL_STEP = {
  name: "Cancel pull request run after code quality failure",
  uses: CANONICAL_CANCEL_STEP.uses,
  with: {
    retries: 0,
    script: CANCEL_FAILURE_SCRIPT.replaceAll(
      "cancelling failed merge group",
      "cancelling the pull request run after a code quality failure",
    ).replace("Merge group failed:", "Code quality failed:"),
  },
} as const;

/** Jobs whose failure ends the rest of a pull request run. */
export const PR_CODE_QUALITY_JOBS = [
  "code-quality-api",
  "code-quality-web-rest",
] as const;

export const PR_CODE_QUALITY_CANCEL_JOBS = {
  "code-quality-api-cancel": "code-quality-api",
  "code-quality-web-rest-cancel": "code-quality-web-rest",
} as const;

export const PR_CODE_QUALITY_CANCEL_IF =
  "failure() && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository";

/** How long the dispatched run waits for the failed job to end. */
export const CANCEL_AFTER_JOB_WAIT_MS = 120_000;
export const CANCEL_AFTER_JOB_POLL_MS = 2000;

// The dispatched run cancels only a CI Checks run attempt whose named job
// failed. It waits for that job to end, so the job keeps its failure
// conclusion; a job still running at the deadline with a failed step is
// cancelled with the run, so a slow cleanup never costs the fast cancellation.
// The wait is bounded by elapsed time, and a lookup that fails transiently (a
// 5xx, a rate limit, a network error) is retried until the deadline: the
// producer has already returned, so nothing else would cancel the run. A rerun
// keeps the run id, so a later attempt than the one that failed is left alone.
export const CANCEL_AFTER_JOB_SCRIPT = `const runId = Number(process.env.RUN_ID);
const runAttempt = Number(process.env.RUN_ATTEMPT);
const jobId = Number(process.env.JOB_ID);
const positive = /^[1-9][0-9]*$/;
if (!positive.test(process.env.RUN_ID || "") || !positive.test(process.env.RUN_ATTEMPT || "")
  || !positive.test(process.env.JOB_ID || "")
  || !Number.isSafeInteger(runId) || !Number.isSafeInteger(runAttempt) || !Number.isSafeInteger(jobId)) {
  core.setFailed("run_id, run_attempt and job_id must be positive integers.");
  return;
}
const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId });
if (run.path !== ".github/workflows/ci.yml") {
  core.setFailed(\`Run \${runId} is not a CI Checks run.\`);
  return;
}
const deadline = Date.now() + ${CANCEL_AFTER_JOB_WAIT_MS};
let job;
for (;;) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    break;
  }
  try {
    ({ data: job } = await github.rest.actions.getJobForWorkflowRun({
      ...context.repo,
      job_id: jobId,
      request: { timeout: remaining },
    }));
  } catch (error) {
    const status = error && typeof error.status === "number" ? error.status : undefined;
    if (status !== undefined && status < 500 && status !== 429) {
      core.setFailed(\`Job \${jobId} could not be read (\${status}); run \${runId} is left running.\`);
      return;
    }
    core.info(\`Job \${jobId} lookup failed transiently (\${status ?? (error && error.message)}); retrying.\`);
  }
  if (job !== undefined) {
    if (job.run_id !== runId || job.run_attempt !== runAttempt) {
      core.setFailed(\`Job \${jobId} is not part of run \${runId} attempt \${runAttempt}.\`);
      return;
    }
    if (job.status === "completed") {
      break;
    }
  }
  const wait = Math.min(${CANCEL_AFTER_JOB_POLL_MS}, deadline - Date.now());
  if (wait <= 0) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, wait));
}
if (job === undefined) {
  core.setFailed(\`Job \${jobId} could not be read before the deadline; run \${runId} is left running.\`);
  return;
}
const failed = job.status === "completed"
  ? job.conclusion === "failure"
  : (job.steps || []).some((step) => step.conclusion === "failure");
if (!failed) {
  core.setFailed(\`\${job.name} did not fail (\${job.status}, \${job.conclusion}); run \${runId} is left running.\`);
  return;
}
const { data: current } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runId });
if (current.run_attempt !== runAttempt) {
  core.notice(\`Run \${runId} is on attempt \${current.run_attempt}, not \${runAttempt}; it is left running.\`);
  return;
}
if (current.status === "completed") {
  core.notice(\`Run \${runId} has already ended.\`);
  return;
}
await github.rest.actions.cancelWorkflowRun({ ...context.repo, run_id: runId });
core.notice(\`Cancelled run \${runId} after \${job.name} failed: \${job.html_url}\`);
await core.summary.addRaw(\`Cancelled run \${runId} after \${job.name} failed: \${job.html_url}\\n\`).write();
`;

export const CANCEL_AFTER_JOB_STEP = {
  name: "Cancel the run once the failed job ends",
  uses: CANONICAL_CANCEL_STEP.uses,
  env: {
    RUN_ID: `\${{ inputs.run_id }}`,
    RUN_ATTEMPT: `\${{ inputs.run_attempt }}`,
    JOB_ID: `\${{ inputs.job_id }}`,
  },
  with: {
    retries: 0,
    script: CANCEL_AFTER_JOB_SCRIPT,
  },
} as const;
