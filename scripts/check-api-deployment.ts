const DEFAULT_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

class ApiDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiDeploymentError";
  }
}

export const parseHealthCommit = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const commit = Reflect.get(value, "commit");
  if (typeof commit !== "string" || !COMMIT_SHA_PATTERN.test(commit)) {
    return undefined;
  }
  return commit;
};

const readRequiredEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ApiDeploymentError(`${name} is required`);
  }
  return value;
};

const readPositiveInteger = (name: string, fallback: number) => {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiDeploymentError(`${name} must be a positive integer`);
  }
  return value;
};

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const readDeployedCommit = async (apiUrl: string) => {
  const healthUrl = new URL("/health", `${apiUrl.replace(/\/+$/u, "")}/`);
  const response = await fetch(healthUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ApiDeploymentError(
      `${healthUrl.toString()} returned HTTP ${response.status}`,
    );
  }
  const commit = parseHealthCommit(await response.json());
  if (!commit) {
    throw new ApiDeploymentError(
      `${healthUrl.toString()} did not return a full commit SHA`,
    );
  }
  return commit;
};

const main = async () => {
  const apiUrl = readRequiredEnv("API_DEPLOYMENT_URL");
  const expectedCommit = readRequiredEnv("API_DEPLOYMENT_EXPECTED_COMMIT");
  if (!COMMIT_SHA_PATTERN.test(expectedCommit)) {
    throw new ApiDeploymentError(
      "API_DEPLOYMENT_EXPECTED_COMMIT must be a full lowercase commit SHA",
    );
  }
  const attempts = readPositiveInteger(
    "API_DEPLOYMENT_ATTEMPTS",
    DEFAULT_ATTEMPTS,
  );
  const delayMs = readPositiveInteger(
    "API_DEPLOYMENT_DELAY_MS",
    DEFAULT_DELAY_MS,
  );

  let lastObservedCommit: string | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each probe must observe the deployed commit before deciding whether to retry.
      lastObservedCommit = await readDeployedCommit(apiUrl);
      if (lastObservedCommit === expectedCommit) {
        console.log(`api-deployment: ok (${expectedCommit})`);
        return;
      }
      console.log(
        `api-deployment: waiting for ${expectedCommit}; observed ${lastObservedCommit} (${attempt}/${attempts})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `api-deployment: probe failed (${attempt}/${attempts}): ${message}`,
      );
    }
    if (attempt < attempts) {
      // eslint-disable-next-line no-await-in-loop -- deployment probes are intentionally sequential and bounded.
      await sleep(delayMs);
    }
  }

  throw new ApiDeploymentError(
    `production did not reach ${expectedCommit}; last observed ${lastObservedCommit ?? "unavailable"}`,
  );
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`api-deployment: ${message}`);
    process.exit(1);
  });
}
