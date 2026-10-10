// parser-output-unchanged: pure error classification does not alter fetch execution or successful records.
const CONNECTION_ERROR_CODES = new Set([
  "ConnectionRefused",
  "FailedToOpenSocket",
  "ConnectionClosed",
  "ConnectionTimeout",
  "SocketTimeout",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
  "EPROTO",
  "ERR_SOCKET_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "CERT_NOT_YET_VALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "INVALID_CA",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

export const isConnectionFailure = (cause: unknown): boolean => {
  const visited = new Set<unknown>();
  const codes: string[] = [];
  const messages: string[] = [];
  let current = cause;
  while (
    (Error.isError(current) || current instanceof Error) &&
    !visited.has(current)
  ) {
    visited.add(current);
    if (current.name === "AbortError" || current.name === "TimeoutError") {
      return false;
    }
    if ("code" in current && typeof current.code === "string") {
      codes.push(current.code);
    }
    messages.push(current.message);
    current = current.cause;
  }
  if (codes.length > 0) {
    return codes.some(
      (code) =>
        CONNECTION_ERROR_CODES.has(code) ||
        code.startsWith("ERR_SSL_") ||
        code.startsWith("ERR_TLS_"),
    );
  }
  return messages.some((message) =>
    /^(?:Unable to connect|Failed to fetch|fetch failed|NetworkError|Load failed|TLS handshake failed|DNS lookup failed)/iu.test(
      message,
    ),
  );
};
