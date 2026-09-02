// Grouping identity for `$exception` events. PostHog derives issues from
// `$exception_list` content; with messages and stacks redacted by the
// exception sanitizer, that default collapses to roughly one issue per
// error class. `$exception_fingerprint` overrides it with a structural
// identity built only from components the sanitizer already keeps, so
// distinct defects create distinct issues without weakening redaction.

// Frames beyond the crash site describe generic dispatch (schedulers,
// event loops) and dilute identity more than they sharpen it.
const FRAME_IDENTITY_LIMIT = 3;

type FingerprintFrame = {
  filename?: string;
  function?: string;
};

type FingerprintEntry = {
  type: string;
  stacktrace?: { frames: readonly FingerprintFrame[] };
};

/**
 * Response identity of a failed API call: the HTTP status and the server's
 * stable error code. Both are structural, so an `ApiError` groups per outcome
 * (a 404 on a gated route, a 402 usage rejection, a 503) instead of one issue
 * for every failed request.
 */
export type ApiErrorIdentity = {
  status: number;
  code?: string | undefined;
};

type ExceptionFingerprintInput = {
  /**
   * Sanitized `$exception_list`: the first entry is the thrown error, later
   * entries its cause chain.
   */
  entries: readonly FingerprintEntry[];
  /** Validated telemetry area slug, when an error boundary declared one. */
  area?: string | undefined;
  /** Validated API response identity, when the error is an `ApiError`. */
  http?: ApiErrorIdentity | undefined;
};

// The asset path up to the basename is deployment layout, not defect
// identity, and query strings or fragments can carry tokens. Keep only
// the final path segment.
const assetBasename = (filename: string): string => {
  const terminator = filename.search(/[?#]/u);
  const path = terminator === -1 ? filename : filename.slice(0, terminator);
  return path.slice(path.lastIndexOf("/") + 1);
};

// Vite content-hashes chunk basenames (`matter-view-D3kfQx9a.js`), so a
// rebuild renames the chunk without the defect changing. Strip the hash
// segment so a fingerprint survives deployments; a basename with no hash
// passes through unchanged.
const CHUNK_HASH_SUFFIX = /-[A-Za-z0-9_-]{8}(?=\.[a-z]+$)/u;
const stableBasename = (basename: string): string =>
  basename.replace(CHUNK_HASH_SUFFIX, "");

const frameIdentity = (frame: FingerprintFrame): string => {
  const basename =
    frame.filename === undefined
      ? ""
      : stableBasename(assetBasename(frame.filename));
  const symbol = frame.function ?? "";
  return basename === "" && symbol === "" ? "" : `${basename}:${symbol}`;
};

// Frames are ordered caller-first, so the tail of the list is the crash
// site. A frameless error legitimately yields no identities.
const frameIdentities = (entry: FingerprintEntry | undefined): string[] => {
  if (entry?.stacktrace === undefined) {
    return [];
  }
  return entry.stacktrace.frames
    .map(frameIdentity)
    .filter((identity) => identity !== "")
    .slice(-FRAME_IDENTITY_LIMIT);
};

/**
 * Positions are fixed (an empty component stays empty) so one component can
 * never collide with another — the same shape the server-side capture
 * wrapper uses for its `$exception_fingerprint`. The API identity is a
 * trailing fifth component present only for API errors: appending rather
 * than reserving keeps every existing identity byte-for-byte stable, and a
 * class list can never start with a digit, so the two shapes cannot collide.
 */
export const fingerprintExceptionEvent = ({
  area,
  entries,
  http,
}: ExceptionFingerprintInput): string => {
  const classes = entries.map((entry) => entry.type);
  const identity = [
    classes.at(0) ?? "UnknownError",
    area ?? "",
    frameIdentities(entries.at(0)).join(";"),
    classes.slice(1).join(";"),
  ].join("|");
  if (http === undefined) {
    return identity;
  }
  const code = http.code === undefined ? "" : `:${http.code}`;
  return `${identity}|${http.status}${code}`;
};
