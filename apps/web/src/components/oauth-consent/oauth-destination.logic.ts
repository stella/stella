import type { OAuthConsentInfo } from "@/lib/oauth-provider";

const isLoopbackHost = (host: string): boolean => {
  const url = URL.parse(`http://${host}`);
  if (!url || url.host !== host || url.username || url.password) {
    return false;
  }
  return (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)
  );
};

/** Prefer the requested redirect; a client may register both local and hosted destinations. */
export const classifyOAuthDestination = (
  info: OAuthConsentInfo,
  redirectUri: string | null,
): "loopback" | "hosted" => {
  if (redirectUri !== null) {
    const url = URL.parse(redirectUri);
    return url &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHost(url.host)
      ? "loopback"
      : "hosted";
  }
  return info.redirectHosts.length > 0 &&
    info.redirectHosts.every(isLoopbackHost)
    ? "loopback"
    : "hosted";
};
