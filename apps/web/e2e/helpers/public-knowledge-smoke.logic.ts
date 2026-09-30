const normalizeMountedApiPath = (pathname: string): string =>
  pathname.replace(/^\/api(?=\/(?:v1|auth)(?:\/|$))/u, "");

const PUBLIC_AUTH_PATHS = new Set(["/auth/get-session"]);

type SmokeRequestOptions = {
  pathname: string;
  method: string;
};

export const isMemberOnlySmokeRequest = ({
  pathname,
  method,
}: SmokeRequestOptions): boolean => {
  const normalizedPath = normalizeMountedApiPath(pathname);

  if (normalizedPath === "/auth" || normalizedPath.startsWith("/auth/")) {
    return method !== "GET" || !PUBLIC_AUTH_PATHS.has(normalizedPath);
  }

  if (normalizedPath === "/v1" || normalizedPath.startsWith("/v1/")) {
    return !normalizedPath.startsWith("/v1/public/");
  }

  return false;
};
