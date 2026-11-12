/** The runtime variables a command inherits from the Lambda; nothing else. */
const INHERITED_KEYS = ["PATH", "LANG", "LD_LIBRARY_PATH"] as const;

/** The variables HTTP clients read their proxy from, in both spellings. */
const PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
] as const;

export type CommandPlaces = {
  home: string;
  cache: string;
  tmp: string;
  skillDir: string;
};

/**
 * The environment one command runs with. Built from an allowlist, so the
 * Lambda's own variables (its AWS credentials, the runtime API address, any
 * function configuration) never reach a skill's code. The proxy URL, when
 * given, is the only route out; with none, HTTP clients have no proxy and the
 * sandbox's network has no route.
 */
export const commandEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  places: CommandPlaces,
  egressProxyUrl: string | null,
): Record<string, string> =>
  Object.fromEntries([
    ...INHERITED_KEYS.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value] as const];
    }),
    ["HOME", places.home],
    ["XDG_CACHE_HOME", places.cache],
    ["TMPDIR", places.tmp],
    ["SKILL_DIR", places.skillDir],
    ["TZ", "UTC"],
    ...(egressProxyUrl === null
      ? []
      : PROXY_KEYS.map((key) => [key, egressProxyUrl] as const)),
  ]);

/** The Lambda's own environment, the only place the runner reads it. */
export const lambdaEnvironment = (): Readonly<
  Record<string, string | undefined>
> => process.env;
