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
  in_app?: boolean;
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
  /** Configured origin whose Vite assets may have content hashes removed. */
  firstPartyOrigin: string;
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

// Vite content-hashes first-party chunk basenames
// (`matter-view-D3kfQx9a.js`), so a rebuild renames the chunk without the
// defect changing. PostHog's parser marks ordinary external URLs `in_app`,
// so trust only the configured app origin and Vite's owned asset directory.
const CHUNK_HASH_SUFFIX = /-[A-Za-z0-9_-]{8}(?=\.[a-z]+$)/u;
const stableBasename = (basename: string): string =>
  basename.replace(CHUNK_HASH_SUFFIX, "");

type FirstPartyAssetOptions = {
  filename: string;
  firstPartyOrigin: string;
};

const isFirstPartyAsset = ({
  filename,
  firstPartyOrigin,
}: FirstPartyAssetOptions): boolean => {
  if (
    !URL.canParse(firstPartyOrigin) ||
    !URL.canParse(filename, firstPartyOrigin)
  ) {
    return false;
  }
  const appOrigin = new URL(firstPartyOrigin).origin;
  const frameUrl = new URL(filename, firstPartyOrigin);
  return (
    frameUrl.origin === appOrigin && frameUrl.pathname.startsWith("/assets/")
  );
};

const frameIdentity = (
  frame: FingerprintFrame,
  firstPartyOrigin: string,
): string => {
  if (frame.filename === undefined) {
    return "";
  }
  const basename = assetBasename(frame.filename);
  return isFirstPartyAsset({ filename: frame.filename, firstPartyOrigin })
    ? stableBasename(basename)
    : basename;
};

// Frames are ordered caller-first, so the tail of the list is the crash
// site. A frameless error legitimately yields no identities.
const frameIdentities = (
  entry: FingerprintEntry | undefined,
  firstPartyOrigin: string,
): string[] => {
  if (entry?.stacktrace === undefined) {
    return [];
  }
  return entry.stacktrace.frames
    .map((frame) => frameIdentity(frame, firstPartyOrigin))
    .filter((identity) => identity !== "")
    .slice(-FRAME_IDENTITY_LIMIT);
};

/**
 * Component slots are fixed (an empty component stays empty), so one cannot
 * collide with another. Function names are deliberately absent: an engine
 * can infer one from a data-derived computed property key, and a bundler can
 * rename it while the source stays unchanged. Bundle line and column numbers
 * also shift between builds. Errors in the same asset chain may therefore
 * group together; area, class and cause identity split them when available.
 * The API identity is a trailing fifth component present only for API errors:
 * a class list can never start with a digit, so the two shapes cannot collide.
 */
export const fingerprintExceptionEvent = ({
  area,
  entries,
  firstPartyOrigin,
  http,
}: ExceptionFingerprintInput): string => {
  const classes = entries.map((entry) => entry.type);
  const identity = [
    classes.at(0) ?? "UnknownError",
    area ?? "",
    frameIdentities(entries.at(0), firstPartyOrigin).join(";"),
    classes.slice(1).join(";"),
  ].join("|");
  if (http === undefined) {
    return identity;
  }
  const code = http.code === undefined ? "" : `:${http.code}`;
  return `${identity}|${http.status}${code}`;
};
