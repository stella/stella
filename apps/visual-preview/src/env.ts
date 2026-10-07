const BROWSER_ENV_KEYS = [
  "HOME",
  "FONTCONFIG_PATH",
  "LD_LIBRARY_PATH",
] as const;

export const browserEnvironment = (
  source: Record<string, string | undefined>,
) => {
  const entries: [string, string][] = [];
  for (const key of BROWSER_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
};

export const getBrowserEnvironment = () => browserEnvironment(process.env);
