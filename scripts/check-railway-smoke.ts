const API_URL_ENV = "RAILWAY_SMOKE_API_URL";
const WEB_URL_ENV = "RAILWAY_SMOKE_WEB_URL";
const EXPECTED_COMMIT_ENV = "RAILWAY_SMOKE_EXPECTED_COMMIT";
const PROBE_ATTEMPTS = 30;
const PROBE_DELAY_MS = 2000;
const PROBE_TIMEOUT_MS = 10_000;

class RailwaySmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailwaySmokeError";
  }
}

const readRequiredEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new RailwaySmokeError(`${name} is required`);
  }
  return stripTrailingSlash(value);
};

const readOptionalEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  return value;
};

const stripTrailingSlash = (value: string) => value.replace(/\/+$/u, "");

const appendPath = (baseUrl: string, path: string) =>
  new URL(path, `${baseUrl}/`).toString();

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fetchWithTimeout = async (url: string) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new RailwaySmokeError(`${url} returned ${response.status}`);
  }
  return response;
};

const checkApiHealth = async (apiUrl: string, expectedCommit?: string) => {
  const url = appendPath(apiUrl, "/health");
  const value: unknown = await (await fetchWithTimeout(url)).json();
  if (!isRecord(value)) {
    throw new RailwaySmokeError("API /health did not return an object");
  }
  if (value["status"] !== "ok") {
    throw new RailwaySmokeError("API /health did not return status=ok");
  }
  expectCommit({ value, expectedCommit, source: "API /health" });
};

const checkWebHealth = async (webUrl: string) => {
  await fetchWithTimeout(appendPath(webUrl, "/health"));
};

const checkWebVersion = async (webUrl: string, expectedCommit: string) => {
  const url = appendPath(webUrl, "/version.json");
  const value: unknown = await (await fetchWithTimeout(url)).json();
  if (!isRecord(value)) {
    throw new RailwaySmokeError("web /version.json did not return an object");
  }
  expectCommit({ value, expectedCommit, source: "web /version.json" });
};

type ExpectCommitInput = {
  value: Record<string, unknown>;
  expectedCommit?: string;
  source: string;
};

const expectCommit = ({ value, expectedCommit, source }: ExpectCommitInput) => {
  if (!expectedCommit) {
    return;
  }
  if (value["commit"] !== expectedCommit) {
    throw new RailwaySmokeError(
      `${source} reported commit ${String(value["commit"])}; expected ${expectedCommit}`,
    );
  }
};

const runProbe = async (name: string, probe: () => Promise<void>) => {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- retry probes must observe the result before deciding whether to wait and try again.
      await probe();
      console.log(`${name}: ok`);
      return;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new RailwaySmokeError(`${name} failed: ${String(error)}`);
      if (attempt === PROBE_ATTEMPTS) {
        break;
      }
      console.log(`${name}: waiting (${attempt}/${PROBE_ATTEMPTS})`);
      // eslint-disable-next-line no-await-in-loop -- retries are intentionally sequential to give the deployment time to become healthy.
      await sleep(PROBE_DELAY_MS);
    }
  }

  if (lastError) {
    throw new RailwaySmokeError(lastError.message);
  }
  throw new RailwaySmokeError(`${name} failed`);
};

const main = async () => {
  const apiUrl = readRequiredEnv(API_URL_ENV);
  const webUrl = readRequiredEnv(WEB_URL_ENV);
  const expectedCommit = readOptionalEnv(EXPECTED_COMMIT_ENV);

  await runProbe("api /health", () => checkApiHealth(apiUrl, expectedCommit));
  await runProbe("web /health", () => checkWebHealth(webUrl));

  if (expectedCommit) {
    await runProbe("web /version.json", () =>
      checkWebVersion(webUrl, expectedCommit),
    );
  }

  console.log("railway-smoke: ok");
};

await main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`railway-smoke: ${error.message}`);
  } else {
    console.error(`railway-smoke: ${String(error)}`);
  }
  process.exit(1);
});
