#!/usr/bin/env bun
import {
  checkRegistry,
  DAY_SECONDS,
  newestStableTag,
  readPackageManifest,
  type RegistryFetch,
  type RegistryResult,
  versionBumpTime,
} from "./check-npm-publish-lag";
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

const DEPLOYED_COMMIT = /^[\da-f]{40}$/u;

type PublishedVersionsOptions = {
  ref: string;
  registry: string;
  cliUrl: string;
  timeoutMs: number;
  now: number;
  directories?: readonly (typeof ALL_PACKAGE_ORDER)[number][];
  gitRunner?: GitRunner;
  healthFetch?: RegistryFetch;
  registryFetch?: RegistryFetch;
  log?: (line: string) => void;
};

type PromotionAssessment = {
  result: RegistryResult;
  release?: string;
};

export const checkPublishedVersions = async ({
  ref,
  registry,
  cliUrl,
  timeoutMs,
  now,
  directories = ALL_PACKAGE_ORDER,
  gitRunner = git,
  healthFetch = fetch,
  registryFetch = fetch,
  log = console.log,
}: PublishedVersionsOptions): Promise<boolean> => {
  let deployedCommitRequest: Promise<string | undefined> | undefined;
  const deployedCommit = async () => {
    deployedCommitRequest ??= (async () => {
      try {
        const response = await healthFetch(
          `${cliUrl.replace(/\/$/u, "")}/health`,
          {
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!response.ok) {
          return undefined;
        }
        const payload: unknown = await response.json();
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("commit" in payload) ||
          typeof payload.commit !== "string" ||
          !DEPLOYED_COMMIT.test(payload.commit)
        ) {
          return undefined;
        }
        return payload.commit;
      } catch {
        return undefined;
      }
    })();
    return deployedCommitRequest;
  };

  // A shallow clone treats its oldest commit as a root, so every package
  // would look bumped there; only complete history can name the bump.
  let completeHistory: boolean | undefined;
  const hasCompleteHistory = () => {
    if (completeHistory === undefined) {
      const shallow = gitRunner(["rev-parse", "--is-shallow-repository"]);
      completeHistory =
        shallow.exitCode === 0 && shallow.stdout.trim() === "false";
    }
    return completeHistory;
  };

  type PromotionAssessmentOptions = {
    directory: string;
    target: string | undefined;
    result: RegistryResult;
  };
  const assessPromotion = async ({
    directory,
    target,
    result,
  }: PromotionAssessmentOptions): Promise<PromotionAssessment> => {
    if (result.status !== "failed" || result.reason !== "version_mismatch") {
      return { result };
    }
    // Only a registry behind main can be waiting for the release to deploy.
    if (
      target === undefined ||
      Bun.semver.order(result.latest, target) !== -1
    ) {
      return { result };
    }
    if (!hasCompleteHistory()) {
      return { result };
    }
    const path = `packages/${directory}/package.json`;
    const bump = gitRunner([
      "log",
      "-1",
      "--format=%H",
      "-G",
      '"version"[[:space:]]*:',
      ref,
      "--",
      path,
    ]);
    const bumpCommit = bump.stdout.trim();
    if (bump.exitCode !== 0 || !DEPLOYED_COMMIT.test(bumpCommit)) {
      return { result };
    }
    const deployed = await deployedCommit();
    if (deployed === undefined) {
      return { result };
    }
    const local = gitRunner(["cat-file", "-e", `${deployed}^{commit}`]);
    if (local.exitCode !== 0) {
      return { result };
    }
    const ancestor = gitRunner([
      "merge-base",
      "--is-ancestor",
      bumpCommit,
      deployed,
    ]);
    if (ancestor.exitCode !== 1) {
      return { result };
    }
    const tags = gitRunner([
      "tag",
      "--contains",
      bumpCommit,
      "--sort=v:refname",
    ]);
    if (tags.exitCode !== 0) {
      return { result };
    }
    // Version sorting puts the earliest stable release carrying the bump first.
    let release = newestStableTag(
      tags.stdout.split("\n").map((tag) => tag.trim()),
    );
    if (release === undefined) {
      const version = gitRunner(["show", `${bumpCommit}:VERSION`]);
      if (version.exitCode !== 0 || version.stdout.trim() === "") {
        return { result };
      }
      release = `v${version.stdout.trim()} (untagged)`;
    }
    return {
      result: { status: "failed", reason: "publish_awaits_promote" },
      release,
    };
  };

  let failed = false;
  // Batches bound network concurrency and keep the five-minute workflow budget.
  for (let offset = 0; offset < directories.length; offset += 4) {
    const results = await Promise.all(
      directories.slice(offset, offset + 4).map(async (directory) => {
        let result: RegistryResult = {
          status: "failed",
          reason: "contract_error",
        };
        let target: string | undefined;
        try {
          const path = `packages/${directory}/package.json`;
          const contents = gitRunner(["show", `${ref}:${path}`]);
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
          const manifest = readPackageManifest({
            directory,
            text: contents.exitCode === 0 ? contents.stdout : undefined,
            policy: "journey",
          });
          if (history.exitCode === 0 && manifest !== undefined) {
            target = manifest.version;
            result = await checkRegistry({
              name: manifest.name,
              version: manifest.version,
              movedRepository: MOVED_PACKAGE_REPOSITORIES[directory],
              bumpedAt: versionBumpTime(history.stdout),
              now,
              registry,
              timeoutMs,
              fetchImpl: registryFetch,
            });
          }
        } catch {
          // The command boundary reports malformed manifests without their contents.
          result = { status: "failed", reason: "contract_error" };
        }
        const assessment = await assessPromotion({ directory, target, result });
        log(
          `journey registry-@stll/${directory} ${assessment.result.status} ${assessment.result.reason}`,
        );
        if (assessment.release !== undefined) {
          log(
            `journey-detail registry-@stll/${directory} awaits ${assessment.release}`,
          );
        }
        return assessment.result;
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
    cliUrl: process.env["JOURNEY_CLI_URL"] ?? "https://api.stll.app",
    timeoutMs: Number(process.env["JOURNEY_REGISTRY_TIMEOUT_MS"] ?? "10000"),
    now: Math.floor(Date.now() / 1000),
  });
  process.exitCode = failed ? 1 : 0;
}
