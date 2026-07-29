const SKILL_SOURCE_PATHS = new Set([
  "/skills/discover-url",
  "/skills/import-url",
  "/skills/import-urls",
]);

export const isSkillSourceRateLimitedRequest = (
  request: Pick<Request, "method" | "url">,
): boolean => {
  if (request.method !== "POST") {
    return false;
  }
  const { pathname } = new URL(request.url);
  const versionlessPath = pathname.startsWith("/v1/")
    ? pathname.slice("/v1".length)
    : pathname;
  const normalizedPath = versionlessPath.endsWith("/")
    ? versionlessPath.slice(0, -1)
    : versionlessPath;
  return SKILL_SOURCE_PATHS.has(normalizedPath);
};
