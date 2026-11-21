/**
 * @param {Array<{context?: string, target_url?: string, description?: string}> | Array<Array<{context?: string, target_url?: string, description?: string}>>} statuses
 * @param {string | undefined} runUrl
 * @param {string | undefined} runId
 */
export const mainHeavyAlertKind = (statuses, runUrl, runId) => {
  const runPath = `/actions/runs/${runId}`;
  const matching = statuses
    .flatMap((page) => (Array.isArray(page) ? page : [page]))
    .find(
      ({ context, target_url: targetUrl }) =>
        context === "main/heavy" &&
        typeof targetUrl === "string" &&
        (targetUrl === runUrl || targetUrl.includes(runPath)),
    );
  return /CODE 0, INFRA [1-9][0-9]*/u.test(matching?.description ?? "")
    ? "Infrastructure failure"
    : "Failed workflow";
};

if (import.meta.main) {
  const [runUrl, runId] = process.argv.slice(2);
  const statuses = JSON.parse(await new Response(process.stdin).text());
  process.stdout.write(mainHeavyAlertKind(statuses, runUrl, runId));
}
