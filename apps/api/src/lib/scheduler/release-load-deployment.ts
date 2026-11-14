/**
 * Whether this deployment may let the release proof move scheduled jobs.
 *
 * The smoke secret alone gates `/smoke/session`; moving scheduled jobs also
 * requires the deployment to name itself as staging. The deployed binary is
 * built with NODE_ENV=production, so the API's own public origin is the
 * runtime signal: only the staging API origin admits the route, and any other
 * value, including none, refuses it.
 */
const STAGING_API_ORIGINS: ReadonlySet<string> = new Set([
  "https://api-staging.stll.app",
]);

export const releaseLoadAllowed = (publicUrl: string | undefined): boolean => {
  if (publicUrl === undefined || !URL.canParse(publicUrl)) {
    return false;
  }
  return STAGING_API_ORIGINS.has(new URL(publicUrl).origin);
};
