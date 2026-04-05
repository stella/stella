type PostHogConfig = {
  host: string | undefined;
  key: string | undefined;
};

type EnabledPostHogConfig = {
  host: string;
  key: string;
};

export const hasPostHogConfig = (
  config: PostHogConfig,
): config is EnabledPostHogConfig => {
  const { host, key } = config;

  return (
    key !== undefined &&
    key !== "" &&
    key !== "phc_" &&
    host !== undefined &&
    host !== ""
  );
};
