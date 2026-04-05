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
