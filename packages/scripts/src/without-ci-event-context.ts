/**
 * Variables through which a CI runner tells a script which event it serves
 * (a pull request, a merge group, a push) and against which base. A test that
 * spawns a repository script inherits them from the runner, so the script
 * would take the merge-group path inside a merge group and the pull-request
 * path elsewhere; fixtures set the ones they mean explicitly.
 */
export const CI_EVENT_CONTEXT_ENV = [
  "GITHUB_EVENT_NAME",
  "GITHUB_EVENT_PATH",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_HEAD_REF",
  "GITHUB_BASE_REF",
  "MERGE_GROUP_BASE_SHA",
  "RATCHET_BASE_REF",
] as const;

/** `env` without the runner's event context, for spawning a script under test. */
export const withoutCiEventContext = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> => {
  const dropped = new Set<string>(CI_EVENT_CONTEXT_ENV);
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !dropped.has(name)),
  );
};
