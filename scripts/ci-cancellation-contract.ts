import { isDeepStrictEqual } from "node:util";

export const CANCEL_FAILURE_SCRIPT = `let diagnostic;
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
  diagnostic = \`\${context.job}: cancelling failed merge group; failed steps: \${failures.length ? failures.join("; ") : "not yet available from the jobs API"}\`;
} catch {
  diagnostic = \`\${context.job}: cancelling failed merge group; failed-step lookup unavailable\`;
} finally {
  clearTimeout(evidenceTimer);
}
core.error(diagnostic);
try {
  core.summary.addRaw(\`\${diagnostic}\\n\`);
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
  name: "Cancel failed merge-group run",
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
