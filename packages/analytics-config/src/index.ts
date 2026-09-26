// When the API and the web app send analytics to PostHog, and the keys both
// sides must agree on so their events aggregate together.

type PostHogConfig = {
  host: string | undefined;
  key: string | undefined;
};

type EnabledPostHogConfig = {
  host: string;
  key: string;
};

type PostHogEnvironment = PostHogConfig & {
  /** A local development process sends nothing unless `localDebug` is set. */
  suppressTelemetry: boolean;
  localDebug: boolean;
};

/**
 * Whether `config` names a real PostHog project: a key other than the
 * `phc_` placeholder, and a host.
 */
export const hasPostHogProject = <Config extends PostHogConfig>(
  config: Config,
): config is Config & EnabledPostHogConfig => {
  const { host, key } = config;
  return (
    key !== undefined &&
    key !== "" &&
    key !== "phc_" &&
    host !== undefined &&
    host !== ""
  );
};

/**
 * Whether to send analytics at all: only to a real project, and from a
 * suppressed (local development) process only when the local debug flag asks
 * for it.
 */
export const shouldEnablePostHog = <Config extends PostHogEnvironment>(
  config: Config,
): config is Config & EnabledPostHogConfig =>
  hasPostHogProject(config) && (!config.suppressTelemetry || config.localDebug);

/**
 * The PostHog group type organization-level events are filed under. The
 * server capture wrapper and the browser adapter both use it, so client and
 * server events aggregate under the same group.
 */
export const POSTHOG_ORGANIZATION_GROUP_TYPE = "organization";
