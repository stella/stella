type PostHogConfig = {
  key: string | undefined;
  host: string | undefined;
};

type PostHogEnvironment = PostHogConfig & {
  isDev: boolean;
  localDebug: boolean;
};

export const hasRealPostHogProject = ({ key, host }: PostHogConfig): boolean =>
  key !== undefined &&
  key !== "" &&
  key !== "phc_" &&
  host !== undefined &&
  host !== "";

export const shouldEnablePostHog = ({
  key,
  host,
  isDev,
  localDebug,
}: PostHogEnvironment): boolean =>
  hasRealPostHogProject({ key, host }) && (!isDev || localDebug);

export const assertProductionTelemetry = ({
  key,
  host,
  isDev,
}: PostHogConfig & { isDev: boolean }): void => {
  if (isDev) {
    return;
  }
  if (!hasRealPostHogProject({ key, host })) {
    throw new Error(
      "POSTHOG_KEY and POSTHOG_HOST must be set to a real project in production. " +
        "Backend telemetry is disabled when the placeholder value is used.",
    );
  }
};
