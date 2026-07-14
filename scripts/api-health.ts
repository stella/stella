const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export const getApiHealthUrl = (apiUrl: string) =>
  new URL("health", `${apiUrl.replace(/\/+$/u, "")}/`);

export const parseHealthCommit = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const commit = Reflect.get(value, "commit");
  if (typeof commit !== "string" || !COMMIT_SHA_PATTERN.test(commit)) {
    return undefined;
  }
  return commit;
};
