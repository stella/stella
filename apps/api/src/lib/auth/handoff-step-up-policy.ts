const isPathFamily = (path: string, family: string) =>
  path === family || path.startsWith(`${family}/`);

const normalizePath = (path: string) =>
  path
    .replace(/^\/api(?=\/|$)/u, "")
    .replace(/^\/v1(?=\/|$)/u, "")
    .replace(/\/+$/u, "") || "/";

export const requiresHandoffStepUpForRequest = (request: Request): boolean => {
  const path = normalizePath(new URL(request.url).pathname);
  if (
    /(?:^|[/-])exports?(?:[/-]|$)/u.test(path) ||
    /^\/style-sets\/[^/]+\/download$/u.test(path) ||
    /^\/entities\/zip(?:\/|$)/u.test(path) ||
    /^\/invoices\/[^/]+\/pdf$/u.test(path)
  ) {
    return true;
  }
  if (
    isPathFamily(path, "/me/delete") ||
    isPathFamily(path, "/me/two-factor")
  ) {
    return true;
  }
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return false;
  }
  if (/(?:^|\/)(?:members|roles)(?:\/|$)/u.test(path)) {
    return true;
  }
  return [
    "/organization-settings",
    "/organizations",
    "/members",
    "/api-keys",
    "/me/oauth-connections",
  ].some((family) => isPathFamily(path, family));
};

export const requiresHandoffStepUpForAuthPath = (path: string): boolean => {
  const normalized = normalizePath(path).replace(/^\/auth(?=\/|$)/u, "");
  if (
    normalized.startsWith("/two-factor/verify-") ||
    normalized === "/oauth2/token" ||
    [
      "/organization/list",
      "/organization/get-full-organization",
      "/organization/get-active-member",
      "/organization/get-active-member-role",
      "/organization/list-members",
      "/organization/list-user-organizations",
      "/organization/list-invitations",
      "/organization/get-invitation",
    ].includes(normalized)
  ) {
    return false;
  }
  if (
    [
      "/organization",
      "/two-factor",
      "/passkey",
      "/api-key",
      "/oauth2",
      "/admin/oauth2",
      "/sso",
      "/scim",
    ].some((family) => isPathFamily(normalized, family))
  ) {
    return true;
  }
  return [
    "/change-password",
    "/set-password",
    "/change-email",
    "/delete-user",
    "/update-user",
    "/link-social",
    "/unlink-account",
    "/revoke-session-by-id",
    "/email-otp/change-email",
    "/email-otp/request-email-change",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
  ].some((family) => isPathFamily(normalized, family));
};
