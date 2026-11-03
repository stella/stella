#!/usr/bin/env bun
import { parseChangesetEntry } from "./changeset-entry";
import {
  checkPromotedRegistry,
  checkRegistry,
  DAY_SECONDS,
  type FirstPublishResult,
  readPackageManifest,
  type RegistryFetch,
  type RegistryResult,
  versionBumpTime,
} from "./check-npm-publish-lag";
import {
  git,
  type GitRunner,
  readPromotedCliTarget,
} from "./promoted-cli-target";
import {
  ALL_PACKAGE_ORDER,
  MOVED_PACKAGE_REPOSITORIES,
} from "./publish-packages";

// Packages are enrolled at this version and keep it on main until the release
// that carries their first publish bumps it.
const ENROLLMENT_VERSION = "0.0.0";
const CHANGESET_README = ".changeset/README.md";

// The pending changesets on `ref` are the next release's manifest: a package
// they name is published by that release, so its absence from npm is expected.
// Returns undefined when the changeset tree cannot be read.
const readFirstPublish = ({
  gitRunner,
  ref,
  name,
}: {
  gitRunner: GitRunner;
  ref: string;
  name: string;
}): { result: FirstPublishResult; changeset?: string } | undefined => {
  const listing = gitRunner([
    "ls-tree",
    "--name-only",
    ref,
    "--",
    ".changeset/",
  ]);
  if (listing.exitCode !== 0) {
    return undefined;
  }
  for (const file of listing.stdout.split("\n")) {
    if (!file.endsWith(".md") || file === CHANGESET_README) {
      continue;
    }
    const entry = gitRunner(["show", `${ref}:${file}`]);
    if (entry.exitCode !== 0) {
      return undefined;
    }
    if (parseChangesetEntry(entry.stdout).packages.includes(name)) {
      return {
        result: { status: "skipped", reason: "pending_first_publish" },
        changeset: file,
      };
    }
  }
  return { result: { status: "failed", reason: "first_publish_unplanned" } };
};

type PublishedVersionsOptions = {
  ref: string;
  registry: string;
  timeoutMs: number;
  now: number;
  directories?: readonly (typeof ALL_PACKAGE_ORDER)[number][];
  gitRunner?: GitRunner;
  promotionFetch?: RegistryFetch;
  githubToken?: string | undefined;
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
  githubToken,
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
            const promotion = await readPromotedCliTarget({
              now,
              timeoutMs,
              gitRunner,
              promotionFetch,
              githubToken,
            });
            if (promotion.status === "failed") {
              result = { status: "failed", reason: promotion.reason };
              log(`journey-detail registry-@stll/cli ${promotion.message}`);
            } else {
              result = await checkPromotedRegistry({
                ...options,
                mainVersion: manifest.version,
                promotion: {
                  version: promotion.version,
                  promotedAt: promotion.promotedAt,
                },
              });
              log(
                `journey-detail registry-@stll/cli target ${promotion.version} from ${promotion.ref}; publication deadline ${promotion.deadline}; publish using publish-npm.yml`,
              );
            }
          } else if (manifest.version === ENROLLMENT_VERSION) {
            const firstPublish = readFirstPublish({
              gitRunner,
              ref,
              name: manifest.name,
            });
            if (firstPublish !== undefined) {
              result = firstPublish.result;
              log(
                firstPublish.changeset === undefined
                  ? `journey-detail registry-@stll/${directory} is enrolled at ${ENROLLMENT_VERSION} with no pending changeset; add one so the next release publishes it`
                  : `journey-detail registry-@stll/${directory} first publish expected in the release that consumes ${firstPublish.changeset}`,
              );
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
    githubToken: process.env["GITHUB_TOKEN"],
  });
  process.exitCode = failed ? 1 : 0;
}
