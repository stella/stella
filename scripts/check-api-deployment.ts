import { DEPLOY_ENV_CONTRACT } from "../apps/api/src/deploy-env-contract";
import { getApiHealthUrl, parseHealthCommit } from "./api-health";

const DEFAULT_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 10_000;
const DEFAULT_PROBE_PATH = "ready";
const DEFAULT_STABLE_PROBES = 5;
const FETCH_TIMEOUT_MS = 10_000;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

class ApiDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiDeploymentError";
  }
}

/** The probe answered, for an environment other than the expected one. */
export class ApiDeploymentMismatchError extends ApiDeploymentError {
  constructor(message: string) {
    super(message);
    this.name = "ApiDeploymentMismatchError";
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
  await Bun.sleep(ms);
};

const readExpectedEnvironment = () => {
  const value = process.env["API_DEPLOYMENT_EXPECTED_ENVIRONMENT"]?.trim();
  if (!value) {
    return undefined;
  }
  if (value !== "production" && value !== "staging") {
    throw new ApiDeploymentError(
      "API_DEPLOYMENT_EXPECTED_ENVIRONMENT must be production or staging",
    );
  }
  return value;
};

type ReadApiDeploymentOptions = {
  url: URL;
  headers?: Headers;
  timeoutMs?: number;
  expectedEnvironment?: ReturnType<typeof readExpectedEnvironment>;
};

export const readApiDeployment = async ({
  url: probeUrl,
  headers,
  timeoutMs = FETCH_TIMEOUT_MS,
  expectedEnvironment,
}: ReadApiDeploymentOptions) => {
  const response = await fetch(probeUrl, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ApiDeploymentError(
      `${probeUrl.toString()} returned HTTP ${response.status}`,
    );
  }
  const body: unknown = await response.json();
  const commit = parseHealthCommit(body);
  if (!commit) {
    throw new ApiDeploymentError(
      `${probeUrl.toString()} did not return a full commit SHA`,
    );
  }
  if (expectedEnvironment !== undefined) {
    for (const { readinessField } of DEPLOY_ENV_CONTRACT) {
      if (readinessField === undefined) {
        continue;
      }
      const observedEnvironment =
        typeof body === "object" && body !== null
          ? Reflect.get(body, readinessField)
          : undefined;
      if (observedEnvironment !== expectedEnvironment) {
        // An unreported environment is a deployment not ready to prove, not
        // another deployment.
        const ErrorType =
          observedEnvironment === undefined || observedEnvironment === null
            ? ApiDeploymentError
            : ApiDeploymentMismatchError;
        throw new ErrorType(
          `${probeUrl.toString()} ${readinessField} must be ${expectedEnvironment}; observed ${String(observedEnvironment ?? "unset")}`,
        );
      }
    }
  }
  return {
    statusCode: response.status,
    commit,
    status:
      typeof body === "object" &&
      body !== null &&
      Reflect.get(body, "status") === "ok"
        ? "ready"
        : "not-ready",
  } as const;
};

const main = async () => {
  const apiUrl = readRequiredEnv("API_DEPLOYMENT_URL");
  const probePath =
    process.env["API_DEPLOYMENT_PROBE_PATH"]?.trim() || DEFAULT_PROBE_PATH;
  const expectedCommit = readRequiredEnv("API_DEPLOYMENT_EXPECTED_COMMIT");
  const expectedEnvironment = readExpectedEnvironment();
  const headers = new Headers();
  const edgeHeaderName = process.env["EDGE_HEADER_NAME"]?.trim();
  const edgeHeaderValue = process.env["EDGE_HEADER_VALUE"]?.trim();
  if (edgeHeaderName && edgeHeaderValue) {
    headers.set(edgeHeaderName, edgeHeaderValue);
  }
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
      const probe = await readApiDeployment({
        url: getApiHealthUrl(apiUrl, probePath),
        expectedEnvironment,
        headers,
      });
      if (
        probePath === "ready" &&
        (probe.statusCode !== 200 || probe.status !== "ready")
      ) {
        throw new ApiDeploymentError(
          "Readiness probe must return HTTP 200 and status ok",
        );
      }
      lastObservedCommit = probe.commit;
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
      await sleep(delayMs);
    }
  }

  throw new ApiDeploymentError(
    `deployment did not remain at ${expectedCommit} for ${requiredStableProbes} consecutive probes; last observed ${lastObservedCommit ?? "unavailable"}; final streak ${consecutiveMatches}`,
  );
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`api-deployment: ${message}`);
    process.exit(1);
  });
}
