import { Result } from "better-result";
import * as v from "valibot";

const NPM_LATEST_URL = "https://registry.npmjs.org/@stll%2Fcli/latest";
const NPM_LOOKUP_TIMEOUT_MS = 3000;
const stableVersionSchema = v.pipe(
  v.string(),
  v.regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u),
);
const npmPackageSchema = v.looseObject({ version: stableVersionSchema });
type ReleaseChannelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Resolve the update channel from npm, its actual publication authority.
 * Network, HTTP, and schema failures are deliberately silent: update nudges
 * are advisory and must never affect a CLI command's result.
 */
export const fetchLatestCliVersion = async ({
  fetcher = globalThis.fetch,
  timeoutMs = NPM_LOOKUP_TIMEOUT_MS,
}: {
  fetcher?: ReleaseChannelFetch;
  timeoutMs?: number;
} = {}): Promise<string | undefined> => {
  const result = await Result.tryPromise({
    catch: (cause) => cause,
    try: async () => {
      const response = await fetcher(NPM_LATEST_URL, {
        headers: { Accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return undefined;
      }
      const body: unknown = await response.json();
      const parsed = v.safeParse(npmPackageSchema, body);
      return parsed.success ? parsed.output.version : undefined;
    },
  });
  return Result.isOk(result) ? result.value : undefined;
};
