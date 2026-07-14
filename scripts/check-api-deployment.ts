import { getApiHealthUrl, parseHealthCommit } from "./api-health";

const DEFAULT_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 10_000;
const DEFAULT_STABLE_PROBES = 5;
const FETCH_TIMEOUT_MS = 10_000;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

class ApiDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiDeploymentError";
  }
}

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

type AdvanceDeploymentStabilityOptions = {
  consecutiveMatches: number;
  expectedCommit: string;
  observedCommit: string;
  requiredMatches: number;
};

export const advanceDeploymentStability = ({
  consecutiveMatches,
  expectedCommit,
  observedCommit,
  requiredMatches,
}: AdvanceDeploymentStabilityOptions) => {
  const nextConsecutiveMatches =
    observedCommit === expectedCommit ? consecutiveMatches + 1 : 0;
  if (nextConsecutiveMatches >= requiredMatches) {
    return {
      status: "stable",
      consecutiveMatches: nextConsecutiveMatches,
    } as const;
  }
  return {
    status: "waiting",
    consecutiveMatches: nextConsecutiveMatches,
  } as const;
};

const sleep = async (ms: number) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const readDeployedCommit = async (apiUrl: string) => {
  const healthUrl = getApiHealthUrl(apiUrl);
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
  const requiredStableProbes = readPositiveInteger(
    "API_DEPLOYMENT_STABLE_PROBES",
    DEFAULT_STABLE_PROBES,
  );
  if (requiredStableProbes > attempts) {
    throw new ApiDeploymentError(
      "API_DEPLOYMENT_STABLE_PROBES cannot exceed API_DEPLOYMENT_ATTEMPTS",
    );
  }

  let lastObservedCommit: string | undefined;
  let consecutiveMatches = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each probe must observe the deployed commit before deciding whether to retry.
      lastObservedCommit = await readDeployedCommit(apiUrl);
      const stability = advanceDeploymentStability({
        consecutiveMatches,
        expectedCommit,
        observedCommit: lastObservedCommit,
        requiredMatches: requiredStableProbes,
      });
      consecutiveMatches = stability.consecutiveMatches;
      if (stability.status === "stable") {
        console.log(
          `api-deployment: ok (${expectedCommit}; ${requiredStableProbes} consecutive probes)`,
        );
        return;
      }
      if (lastObservedCommit === expectedCommit) {
        console.log(
          `api-deployment: confirming ${expectedCommit} (${consecutiveMatches}/${requiredStableProbes} stable probes; ${attempt}/${attempts} attempts)`,
        );
      } else {
        console.log(
          `api-deployment: waiting for ${expectedCommit}; observed ${lastObservedCommit} (${attempt}/${attempts})`,
        );
      }
    } catch (error) {
      consecutiveMatches = 0;
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
    `production did not remain at ${expectedCommit} for ${requiredStableProbes} consecutive probes; last observed ${lastObservedCommit ?? "unavailable"}; final streak ${consecutiveMatches}`,
  );
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`api-deployment: ${message}`);
    process.exit(1);
  });
}
