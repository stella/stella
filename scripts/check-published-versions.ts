#!/usr/bin/env bun
import {
  checkPromotedRegistry,
  checkRegistry,
  DAY_SECONDS,
  readPackageManifest,
  type RegistryFetch,
  type RegistryResult,
  versionBumpTime,
} from "./check-npm-publish-lag";
import {
  selectPromotedRelease,
  STABLE_RELEASE_TAG,
} from "./promoted-release-policy";
import {
  ALL_PACKAGE_ORDER,
  MOVED_PACKAGE_REPOSITORIES,
} from "./publish-packages";

export type GitResult = { exitCode: number; stdout: string };
export type GitRunner = (args: readonly string[]) => GitResult;

const git: GitRunner = (args) => {
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

// GitHub publishes stable releases after promotion and verification. The checked-in
// changelog dates are updated only at the next release cut and can be stale here.
const readPromotion = async (fetchImpl: RegistryFetch, timeoutMs: number) => {
  const manifest = new Map<string, string>();
  try {
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      // Pagination depends on the previous response; bound pages and requests.
      const response = await fetchImpl(
        `https://api.github.com/repos/stella/stella/releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`,
        { signal: AbortSignal.timeout(timeoutMs) },
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

type PublishedVersionsOptions = {
  ref: string;
  registry: string;
  timeoutMs: number;
  now: number;
  directories?: readonly (typeof ALL_PACKAGE_ORDER)[number][];
  gitRunner?: GitRunner;
  promotionFetch?: RegistryFetch;
  registryFetch?: RegistryFetch;
  log?: (line: string) => void;
};

export const checkPublishedVersions = async ({
  ref,
  registry,
  timeoutMs,
  now,
  directories = ALL_PACKAGE_ORDER,
  gitRunner = git,
  promotionFetch = fetch,
  registryFetch = fetch,
  log = console.log,
}: PublishedVersionsOptions): Promise<boolean> => {
  let failed = false;
  for (let offset = 0; offset < directories.length; offset += 4) {
    const results = await Promise.all(
      directories.slice(offset, offset + 4).map(async (directory) => {
        let result: RegistryResult = {
          status: "failed",
          reason: "contract_error",
        };
        try {
          const path = `packages/${directory}/package.json`;
          const contents = gitRunner(["show", `${ref}:${path}`]);
          const manifest = readPackageManifest({
            directory,
            text: contents.exitCode === 0 ? contents.stdout : undefined,
            policy: "journey",
          });
          if (manifest === undefined) {
            log(
              `journey registry-@stll/${directory} ${result.status} ${result.reason}`,
            );
            return result;
          }
          const options = {
            name: manifest.name,
            now,
            registry,
            timeoutMs,
            fetchImpl: registryFetch,
          };
          if (directory === "cli") {
            const promotion = await readPromotion(promotionFetch, timeoutMs);
            if (promotion.status !== "resolved") {
              if (promotion.status === "unavailable") {
                result = { status: "failed", reason: "promotion_unavailable" };
                log(
                  `journey-detail registry-@stll/cli release metadata ${promotion.reason}`,
                );
              }
              log(`journey-detail registry-@stll/cli ${promotion.message}`);
            } else {
              const promoted = gitRunner(["show", `${promotion.ref}:${path}`]);
              const target = readPackageManifest({
                directory,
                text: promoted.exitCode === 0 ? promoted.stdout : undefined,
                policy: "journey",
              });
              if (target !== undefined && promotion.promotedAt <= now) {
                let promotedAt = promotion.promotedAt;
                for (const previous of promotion.promotions) {
                  if (previous.ref === promotion.ref) {
                    continue;
                  }
                  const previousManifest = gitRunner([
                    "show",
                    `${previous.ref}:${path}`,
                  ]);
                  // A missing historical tag cannot establish the grace deadline.
                  if (previousManifest.exitCode !== 0) {
                    const tag = gitRunner([
                      "cat-file",
                      "-e",
                      `${previous.ref}^{commit}`,
                    ]);
                    if (tag.exitCode !== 0) {
                      log(
                        "journey-detail registry-@stll/cli fetch all promoted release tags before checking publication grace",
                      );
                      log("journey registry-@stll/cli failed contract_error");
                      return result;
                    }
                    continue;
                  }
                  const previousTarget = readPackageManifest({
                    directory,
                    text: previousManifest.stdout,
                    policy: "journey",
                  });
                  if (previousTarget?.version === target.version) {
                    promotedAt = Math.min(promotedAt, previous.promotedAt);
                  }
                }
                result = await checkPromotedRegistry({
                  ...options,
                  mainVersion: manifest.version,
                  promotion: { version: target.version, promotedAt },
                });
                log(
                  `journey-detail registry-@stll/cli target ${target.version} from ${promotion.ref}; publication deadline ${new Date((promotedAt + DAY_SECONDS) * 1000).toISOString()}; publish using publish-npm.yml`,
                );
              }
            }
          } else {
            const history = gitRunner([
              "log",
              ref,
              `--since=@${now - DAY_SECONDS}`,
              "--format=journey-commit %ct",
              "-p",
              "-G",
              '"version"[[:space:]]*:',
              "--",
              path,
            ]);
            if (history.exitCode === 0) {
              result = await checkRegistry({
                ...options,
                version: manifest.version,
                movedRepository: MOVED_PACKAGE_REPOSITORIES[directory],
                bumpedAt: versionBumpTime(history.stdout),
              });
            }
          }
        } catch {
          // The command boundary reports malformed contracts without their contents.
          result = { status: "failed", reason: "contract_error" };
        }
        log(
          `journey registry-@stll/${directory} ${result.status} ${result.reason}`,
        );
        return result;
      }),
    );
    if (results.some((result) => result.status === "failed")) {
      failed = true;
    }
  }
  return failed;
};

if (import.meta.main) {
  const failed = await checkPublishedVersions({
    ref: process.env["JOURNEY_MAIN_REF"] ?? "origin/main",
    registry:
      process.env["JOURNEY_NPM_REGISTRY_URL"] ?? "https://registry.npmjs.org",
    timeoutMs: Number(process.env["JOURNEY_REGISTRY_TIMEOUT_MS"] ?? "10000"),
    now: Math.floor(Date.now() / 1000),
  });
  process.exitCode = failed ? 1 : 0;
}
