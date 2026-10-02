const CONNECTION_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

export const isConnectionFailure = (cause: unknown): boolean => {
  const visited = new Set<unknown>();
  let current = cause;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (
      "code" in current &&
      typeof current.code === "string" &&
      (CONNECTION_ERROR_CODES.has(current.code) ||
        current.code.startsWith("ERR_SSL_") ||
        current.code.startsWith("ERR_TLS_"))
    ) {
      return true;
    }
    if (
      /^(?:Unable to connect|Failed to fetch|fetch failed|NetworkError|Load failed|TLS handshake failed|DNS lookup failed)/iu.test(
        current.message,
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
};
