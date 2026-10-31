import { isDeepStrictEqual } from "node:util";

export const CANCEL_FAILURE_SCRIPT = `let diagnostic;
let failureSummary = "failed-step lookup unavailable";
let evidenceTimer;
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
  const failures = jobs.flatMap((job) => (job.steps || [])
    .filter((step) => step.conclusion === "failure")
    .map((step) => \`\${job.name} / \${step.number}: \${step.name} (\${job.html_url})\`));
  // A lost runner leaves a failed job whose step ended cancelled (or that never ran a step); with no failed
  // step and no such evidence the jobs API may still be catching up, so cancel as before.
  const lost = jobs.filter((job) => job.conclusion === "failure"
    && !(job.steps || []).some((step) => step.conclusion === "failure")
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
await github.rest.actions.cancelWorkflowRun({
  ...context.repo,
  run_id: context.runId,
});
`;

export const CANONICAL_CANCEL_STEP = {
  name: "Cancel merge group after failure in this job",
  uses: "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
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
