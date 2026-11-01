import {
  DAY_SECONDS,
  readPackageManifest,
  type RegistryFetch,
} from "./check-npm-publish-lag";
import {
  selectPromotedRelease,
  STABLE_RELEASE_TAG,
} from "./promoted-release-policy";

type GitResult = { exitCode: number; stdout: string };
export type GitRunner = (args: readonly string[]) => GitResult;

export const git: GitRunner = (args) => {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 10;

type ReadPromotionOptions = {
  fetchImpl: RegistryFetch;
  timeoutMs: number;
  githubToken: string | undefined;
  releasesApiUrl: string;
};

// GitHub publishes stable releases after promotion and verification. The checked-in
// changelog dates are updated only at the next release cut and can be stale here.
// An authenticated read avoids the shared unauthenticated rate limit of hosted
// runners; local runs without a token stay anonymous.
const readPromotion = async ({
  fetchImpl,
  timeoutMs,
  githubToken,
  releasesApiUrl,
}: ReadPromotionOptions) => {
  const manifest = new Map<string, string>();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (githubToken !== undefined && githubToken !== "") {
    headers["Authorization"] = `Bearer ${githubToken}`;
  }
  try {
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      // Pagination depends on the previous response; bound pages and requests.
      const response = await fetchImpl(
        `${releasesApiUrl}?per_page=${RELEASE_PAGE_SIZE}&page=${page}`,
        { signal: AbortSignal.timeout(timeoutMs), headers },
      );
      if (!response.ok) {
        return {
          status: "unavailable" as const,
          reason: "http_status" as const,
          message: `Releases API returned HTTP ${response.status}; retry the registry journey after checking API availability and rate limits.`,
        };
      }
      const releases: unknown = await response.json();
      if (!Array.isArray(releases)) {
        return {
          status: "invalid" as const,
          message: "Invalid release listing; check the Releases API contract.",
        };
      }
      for (const release of releases) {
        if (
          !isRecord(release) ||
          typeof release["tag_name"] !== "string" ||
          typeof release["draft"] !== "boolean" ||
          typeof release["prerelease"] !== "boolean"
        ) {
          return {
            status: "invalid" as const,
            message: "Invalid release entry; check the Releases API contract.",
          };
        }
        if (
          release["draft"] ||
          release["prerelease"] ||
          !STABLE_RELEASE_TAG.test(release["tag_name"])
        ) {
          continue;
        }
        if (typeof release["published_at"] !== "string") {
          return {
            status: "invalid" as const,
            message: "Published stable release has no publication time.",
          };
        }
        manifest.set(release["tag_name"], release["published_at"]);
      }
      if (releases.length < RELEASE_PAGE_SIZE) {
        return selectPromotedRelease(Object.fromEntries(manifest));
      }
    }
    return {
      status: "invalid" as const,
      message:
        "Release listing exceeds the page budget; update the registry journey release reader.",
    };
  } catch (error) {
    return {
      status: "unavailable" as const,
      reason:
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
          ? ("timeout" as const)
          : ("contract_error" as const),
      message:
        "Could not read release metadata; retry the registry journey after checking the Releases API.",
    };
  }
};

type ReadPromotedCliTargetOptions = {
  now: number;
  timeoutMs: number;
  gitRunner?: GitRunner;
  promotionFetch?: RegistryFetch;
  githubToken?: string | undefined;
  releasesApiUrl?: string;
};

export const readPromotedCliTarget = async ({
  now,
  timeoutMs,
  gitRunner = git,
  promotionFetch = fetch,
  githubToken,
  releasesApiUrl = "https://api.github.com/repos/stella/stella/releases",
}: ReadPromotedCliTargetOptions) => {
  const promotion = await readPromotion({
    fetchImpl: promotionFetch,
    timeoutMs,
    githubToken,
    releasesApiUrl,
  });
  if (promotion.status !== "resolved") {
    return {
      status: "failed" as const,
      reason:
        promotion.status === "unavailable"
          ? ("promotion_unavailable" as const)
          : ("contract_error" as const),
      message: promotion.message,
    };
  }
  const path = "packages/cli/package.json";
  const promoted = gitRunner(["show", `${promotion.ref}:${path}`]);
  if (promoted.exitCode !== 0) {
    return {
      status: "failed" as const,
      reason: "contract_error" as const,
      message: `${promotion.ref} has no readable CLI manifest; fetch its tag before checking publication`,
    };
  }
  const target = readPackageManifest({
    directory: "cli",
    text: promoted.stdout,
    policy: "journey",
  });
  if (target === undefined) {
    return {
      status: "failed" as const,
      reason: "contract_error" as const,
      message: `${promotion.ref} has no readable CLI manifest; fetch its tag before checking publication`,
    };
  }
  if (promotion.promotedAt > now) {
    return {
      status: "failed" as const,
      reason: "contract_error" as const,
      message: `${promotion.ref} is published after the check time; check the runner clock and the release metadata`,
    };
  }
  let promotedAt = promotion.promotedAt;
  for (const previous of promotion.promotions) {
    if (previous.ref === promotion.ref) {
      continue;
    }
    const previousManifest = gitRunner(["show", `${previous.ref}:${path}`]);
    if (previousManifest.exitCode !== 0) {
      const tag = gitRunner(["cat-file", "-e", `${previous.ref}^{commit}`]);
      if (tag.exitCode !== 0) {
        return {
          status: "failed" as const,
          reason: "contract_error" as const,
          message:
            "fetch all promoted release tags before checking publication grace",
        };
      }
      continue;
    }
    const previousTarget = readPackageManifest({
      directory: "cli",
      text: previousManifest.stdout,
      policy: "journey",
    });
    if (previousTarget?.version === target.version) {
      promotedAt = Math.min(promotedAt, previous.promotedAt);
    }
  }
  return {
    status: "resolved" as const,
    version: target.version,
    ref: promotion.ref,
    promotedAt,
    deadline: new Date((promotedAt + DAY_SECONDS) * 1000).toISOString(),
  };
};
