// The release failure event: what the API sends and what the post-release
// check (`scripts/release-health.ts`) queries. Both sides read these names,
// so the query cannot drift from the event.
//
// Imports nothing: the release workflow runs the check without installing
// workspace dependencies.

export const RELEASE_FAILURE_EVENT = "release_failure_window";

/** The analytics client stamps every server event with the build's release. */
export const RELEASE_VERSION_PROPERTY = "app_version";

/** Runtime deployment, independent of the image build mode. */
export const RELEASE_ENVIRONMENT_PROPERTY = "deploy_environment";

export const DEPLOY_ENVIRONMENTS = [
  "production",
  "staging",
  "development",
] as const;

/** A failure's identity across releases: where it failed and what failed. */
export const RELEASE_FAILURE_FINGERPRINT_KEYS = [
  "handler",
  "error_class",
  "error_code",
] as const;

/**
 * A window either counts one fingerprint, or counts the observations that
 * found the window's key budget already spent.
 */
export const RELEASE_FAILURE_ENTRY_KINDS = ["fingerprint", "overflow"] as const;

export type ReleaseFailureEntryKind =
  (typeof RELEASE_FAILURE_ENTRY_KINDS)[number];

/**
 * `error_class` or `error_code` of a failure that has none: an error without
 * a code, or a 5xx answered with no error observed at all.
 */
export const NO_ERROR_VALUE = "none";

type ReleaseFailureFingerprint = Record<
  (typeof RELEASE_FAILURE_FINGERPRINT_KEYS)[number],
  string
>;

export type ReleaseFailureEventProperties =
  | (ReleaseFailureFingerprint & {
      kind: "fingerprint";
      failure_reason: string;
      occurrences: number;
    })
  | { kind: "overflow"; occurrences: number };
