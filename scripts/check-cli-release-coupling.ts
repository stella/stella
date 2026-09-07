#!/usr/bin/env bun

// Release gate: a stable application tag may only be cut when the CLI that
// rides on it is settled.
//
// The API and `@stll/cli` share one contract, but they ship on two clocks:
// the API deploys from the `vX.Y.Z` tag, the CLI publishes from that same
// commit only after production serves it. Nothing used to connect the two, so
// a server change could deploy while its CLI changeset still sat in the
// pending Version Packages pull request. Production then spoke a contract the
// published CLI did not, and the compatible CLI had no version to publish
// under.
//
// This script decides, for the commit being tagged, which of two shapes the
// release has, and refuses anything else:
//
//   unchanged  the CLI version on the commit is npm's `latest`, and the
//              generated contract surface (capability catalog, registry
//              snapshot, negotiated API contract) equals the published
//              tarball's. The published CLI keeps working against this release.
//   coupled    the CLI version on the commit is newer than anything published.
//              publish-npm.yml publishes it right after promotion; until then
//              the published CLI may be incompatible, which is the bounded
//              window a breaking contract change costs.
//
// Refused: a pending `.changeset` entry naming `@stll/cli` (the coupled
// version does not exist yet), a CLI version behind npm, or a `latest`-versioned
// commit whose contract surface drifted from the published bytes.
//
// Runs without `bun install`: the tag workflow checks out the repository and
// nothing else, so this file uses only Bun and Node built-ins.
//
//   bun scripts/check-cli-release-coupling.ts --version 1.2.3
//   bun scripts/check-cli-release-coupling.ts --base origin/main

import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CLI_MINIMUM_SERVER_REVISION,
  CLI_REQUIRED_CAPABILITIES,
  CLI_SUPPORTED_API_PROTOCOLS,
} from "../packages/cli/src/generated/api-contract";
import { isChangesetEntry } from "./changeset-guard";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_PACKAGE_NAME = "@stll/cli";
const CLI_DIRECTORY = "packages/cli";
const CHANGESET_DIRECTORY = ".changeset";
const VERSION_FILE = "VERSION";
const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const CHANGESET_FRONTMATTER_FENCE = "---";
/** `"@stll/cli": major`, quoted or bare, as Changesets writes the frontmatter. */
const CLI_CHANGESET_KEY = /^\s*["']?@stll\/cli["']?\s*:/u;

class CliReleaseCouplingError extends Error {
  readonly _tag = "CliReleaseCouplingError";

  constructor(message: string) {
    super(message);
    this.name = "CliReleaseCouplingError";
  }
}

const panic = (message: string): never => {
  throw new CliReleaseCouplingError(message);
};

const parseStableVersion = (version: string): readonly number[] => {
  if (!STABLE_VERSION_PATTERN.test(version)) {
    return panic(`"${version}" is not a plain major.minor.patch version`);
  }
  return version.split(".").map(Number);
};

/** Negative when `a` precedes `b`, positive when it follows, zero when equal. */
export const compareStableVersions = (a: string, b: string): number => {
  const left = parseStableVersion(a);
  const right = parseStableVersion(b);
  for (const [index, part] of left.entries()) {
    const difference = part - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/** The frontmatter package keys of one `.changeset/*.md` entry. */
export const changesetNamesCli = (entry: string): boolean => {
  const lines = entry.split("\n");
  if (lines.at(0)?.trim() !== CHANGESET_FRONTMATTER_FENCE) {
    return false;
  }
  for (const line of lines.slice(1)) {
    if (line.trim() === CHANGESET_FRONTMATTER_FENCE) {
      return false;
    }
    if (CLI_CHANGESET_KEY.test(line)) {
      return true;
    }
  }
  return false;
};

export type PublishedCli = {
  /** npm's `latest` dist-tag. */
  readonly latest: string;
  /** Every version npm has ever published under the package name. */
  readonly versions: readonly string[];
};

type ClassifyCliReleaseInput = {
  /** The application VERSION being released. */
  readonly version: string;
  /** `packages/cli/package.json` version on the release commit. */
  readonly cliVersion: string;
  /** Pending `.changeset` entries that name the CLI. */
  readonly pendingCliChangesets: readonly string[];
  readonly published: PublishedCli;
};

export type CliReleaseClassification =
  | { readonly status: "prerelease" }
  | {
      readonly status: "pending-changesets";
      readonly changesets: readonly string[];
    }
  | {
      readonly status: "behind-npm";
      readonly cliVersion: string;
      readonly latest: string;
    }
  | { readonly status: "published"; readonly cliVersion: string }
  | {
      readonly status: "coupled";
      readonly cliVersion: string;
      readonly latest: string;
    };

/**
 * The ordering rule. A pending CLI changeset dominates: whatever the versions
 * say, the commit does not carry the CLI that would have to ship with it.
 */
export const classifyCliRelease = ({
  version,
  cliVersion,
  pendingCliChangesets,
  published,
}: ClassifyCliReleaseInput): CliReleaseClassification => {
  if (!STABLE_VERSION_PATTERN.test(version)) {
    return { status: "prerelease" };
  }
  if (pendingCliChangesets.length > 0) {
    return { status: "pending-changesets", changesets: pendingCliChangesets };
  }
  const order = compareStableVersions(cliVersion, published.latest);
  if (order === 0) {
    return { status: "published", cliVersion };
  }
  if (order < 0 || published.versions.includes(cliVersion)) {
    return { status: "behind-npm", cliVersion, latest: published.latest };
  }
  return { status: "coupled", cliVersion, latest: published.latest };
};

/** The negotiated contract the CLI bakes in, as plain data for comparison. */
export type ApiContractSnapshot = {
  readonly protocols: readonly number[];
  readonly minimumServerRevision: number;
  readonly requiredCapabilities: Readonly<Record<string, number>>;
};

/** What a published CLI and a commit each contribute to the drift check. */
export type CliContractSurface = {
  readonly apiContract: ApiContractSnapshot;
  /** Raw JSON text; compared after parsing so formatting cannot drift it. */
  readonly capabilityCatalog: string;
  readonly registrySnapshot: string;
};

const canonicalJson = (text: string): string =>
  JSON.stringify(JSON.parse(text) as unknown);

const sortedProtocols = (protocols: readonly number[]): string =>
  JSON.stringify([...protocols].sort((a, b) => a - b));

const sortedCapabilities = (
  capabilities: Readonly<Record<string, number>>,
): string =>
  JSON.stringify(
    Object.entries(capabilities).sort(([a], [b]) => a.localeCompare(b)),
  );

const sameApiContract = (
  a: ApiContractSnapshot,
  b: ApiContractSnapshot,
): boolean =>
  sortedProtocols(a.protocols) === sortedProtocols(b.protocols) &&
  a.minimumServerRevision === b.minimumServerRevision &&
  sortedCapabilities(a.requiredCapabilities) ===
    sortedCapabilities(b.requiredCapabilities);

type SurfaceComparison = {
  readonly head: CliContractSurface;
  readonly published: CliContractSurface;
};

/** Names of the surface parts that differ; empty when the published CLI matches. */
export const findSurfaceDrift = ({
  head,
  published,
}: SurfaceComparison): readonly string[] => {
  const drift: string[] = [];
  if (!sameApiContract(head.apiContract, published.apiContract)) {
    drift.push("src/generated/api-contract.ts");
  }
  if (
    canonicalJson(head.capabilityCatalog) !==
    canonicalJson(published.capabilityCatalog)
  ) {
    drift.push("capability-catalog.json");
  }
  if (
    canonicalJson(head.registrySnapshot) !==
    canonicalJson(published.registrySnapshot)
  ) {
    drift.push("src/generated/registry-snapshot.json");
  }
  return drift;
};

export type CliReleaseVerdict =
  | { readonly status: "not-a-release"; readonly reason: string }
  | { readonly status: "unchanged"; readonly cliVersion: string }
  | {
      readonly status: "coupled";
      readonly cliVersion: string;
      readonly latest: string;
    }
  | { readonly status: "blocked"; readonly message: string };

const REMEDY_PENDING =
  "Merge the pending Version Packages pull request first (or revert the changeset), then re-run tag-on-version-bump from the Actions tab.";

export const verdictFromClassification = (
  classification: CliReleaseClassification,
): CliReleaseVerdict => {
  switch (classification.status) {
    case "prerelease":
      return {
        status: "not-a-release",
        reason: "prerelease VERSION; the CLI publishes only from stable tags",
      };
    case "pending-changesets":
      return {
        status: "blocked",
        message: `pending changesets name ${CLI_PACKAGE_NAME} (${classification.changesets.join(", ")}), so the CLI this release needs has no version yet. ${REMEDY_PENDING}`,
      };
    case "behind-npm":
      return {
        status: "blocked",
        message: `the commit carries ${CLI_PACKAGE_NAME}@${classification.cliVersion} but npm's latest is ${classification.latest}; a release must not ship a CLI behind the one users install.`,
      };
    case "published":
      return { status: "unchanged", cliVersion: classification.cliVersion };
    case "coupled":
      return {
        status: "coupled",
        cliVersion: classification.cliVersion,
        latest: classification.latest,
      };
    default: {
      classification satisfies never;
      throw new CliReleaseCouplingError(
        `Unhandled classification: ${String(classification)}`,
      );
    }
  }
};

export const report = (verdict: CliReleaseVerdict): number => {
  switch (verdict.status) {
    case "not-a-release":
      process.stdout.write(
        `cli-release-coupling: skipped, ${verdict.reason}.\n`,
      );
      return 0;
    case "unchanged":
      process.stdout.write(
        `cli-release-coupling: ok, published ${CLI_PACKAGE_NAME}@${verdict.cliVersion} keeps its contract surface on this release.\n`,
      );
      return 0;
    case "coupled":
      process.stdout.write(
        `cli-release-coupling: ok, coupled release; ${CLI_PACKAGE_NAME}@${verdict.cliVersion} publishes after promotion and replaces ${verdict.latest}.\n`,
      );
      return 0;
    case "blocked":
      process.stderr.write(
        `::error::cli-release-coupling: ${verdict.message}\n`,
      );
      return 1;
    default: {
      verdict satisfies never;
      throw new CliReleaseCouplingError(
        `Unhandled verdict: ${String(verdict)}`,
      );
    }
  }
};

type CommandRun = { readonly ok: boolean; readonly stdout: string };

const run = (command: readonly string[], cwd: string): CommandRun => {
  const result = Bun.spawnSync([...command], {
    cwd,
    stdout: "pipe",
    stderr: "inherit",
  });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString() };
};

const readPendingCliChangesets = (root: string): readonly string[] =>
  readdirSync(path.join(root, CHANGESET_DIRECTORY))
    .map((name) => `${CHANGESET_DIRECTORY}/${name}`)
    .filter(isChangesetEntry)
    .filter((entry) =>
      changesetNamesCli(readFileSync(path.join(root, entry), "utf-8")),
    )
    .sort();

const readCliVersion = (root: string): string => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(root, CLI_DIRECTORY, "package.json"), "utf-8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    return panic(`${CLI_DIRECTORY}/package.json has no string version`);
  }
  return manifest.version;
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const readPublishedCli = (): PublishedCli => {
  const view = run(
    ["npm", "view", CLI_PACKAGE_NAME, "dist-tags.latest", "versions", "--json"],
    REPO_ROOT,
  );
  if (!view.ok) {
    return panic(`npm view ${CLI_PACKAGE_NAME} failed`);
  }
  const parsed: unknown = JSON.parse(view.stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("dist-tags.latest" in parsed) ||
    typeof parsed["dist-tags.latest"] !== "string" ||
    !("versions" in parsed) ||
    !isStringArray(parsed.versions)
  ) {
    return panic(`npm view ${CLI_PACKAGE_NAME} returned an unexpected shape`);
  }
  return { latest: parsed["dist-tags.latest"], versions: parsed.versions };
};

const isNumberArray = (value: unknown): value is readonly number[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "number");

const isCapabilityMap = (
  value: unknown,
): value is Readonly<Record<string, number>> =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every((entry) => typeof entry === "number");

const readApiContractModule = async (
  modulePath: string,
): Promise<ApiContractSnapshot> => {
  const contract: unknown = await import(pathToFileURL(modulePath).href);
  if (
    typeof contract !== "object" ||
    contract === null ||
    !("CLI_SUPPORTED_API_PROTOCOLS" in contract) ||
    !isNumberArray(contract.CLI_SUPPORTED_API_PROTOCOLS) ||
    !("CLI_MINIMUM_SERVER_REVISION" in contract) ||
    typeof contract.CLI_MINIMUM_SERVER_REVISION !== "number" ||
    !("CLI_REQUIRED_CAPABILITIES" in contract) ||
    !isCapabilityMap(contract.CLI_REQUIRED_CAPABILITIES)
  ) {
    return panic(`${modulePath} does not export the generated API contract`);
  }
  return {
    protocols: contract.CLI_SUPPORTED_API_PROTOCOLS,
    minimumServerRevision: contract.CLI_MINIMUM_SERVER_REVISION,
    requiredCapabilities: contract.CLI_REQUIRED_CAPABILITIES,
  };
};

const readHeadSurface = (root: string): CliContractSurface => ({
  apiContract: {
    protocols: CLI_SUPPORTED_API_PROTOCOLS,
    minimumServerRevision: CLI_MINIMUM_SERVER_REVISION,
    requiredCapabilities: CLI_REQUIRED_CAPABILITIES,
  },
  capabilityCatalog: readFileSync(
    path.join(root, CLI_DIRECTORY, "capability-catalog.json"),
    "utf-8",
  ),
  registrySnapshot: readFileSync(
    path.join(root, CLI_DIRECTORY, "src/generated/registry-snapshot.json"),
    "utf-8",
  ),
});

/** Downloads the published tarball and reads the same three surface parts from it. */
const readPublishedSurface = async (
  version: string,
): Promise<CliContractSurface> => {
  const workDir = mkdtempSync(path.join(tmpdir(), "stella-cli-release-"));
  const pack = run(
    [
      "npm",
      "pack",
      `${CLI_PACKAGE_NAME}@${version}`,
      "--pack-destination",
      workDir,
      "--silent",
    ],
    workDir,
  );
  const tarball = pack.stdout.trim().split("\n").at(-1);
  if (!pack.ok || !tarball) {
    return panic(`npm pack ${CLI_PACKAGE_NAME}@${version} failed`);
  }
  if (!run(["tar", "-xzf", path.join(workDir, tarball)], workDir).ok) {
    return panic(`could not extract ${tarball}`);
  }
  const packageRoot = path.join(workDir, "package");
  return {
    apiContract: await readApiContractModule(
      path.join(packageRoot, "dist/generated/api-contract.js"),
    ),
    capabilityCatalog: readFileSync(
      path.join(packageRoot, "capability-catalog.json"),
      "utf-8",
    ),
    registrySnapshot: readFileSync(
      path.join(packageRoot, "dist/generated/registry-snapshot.json"),
      "utf-8",
    ),
  };
};

const readVersionFile = (root: string): string => {
  const file = path.join(root, VERSION_FILE);
  if (!existsSync(file)) {
    return panic(`${VERSION_FILE} file is missing`);
  }
  return readFileSync(file, "utf-8").trim();
};

type Args = { readonly version: string | null; readonly base: string | null };

const parseArgs = (args: readonly string[]): Args => {
  let version: string | null = null;
  let base: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args.at(index + 1);
    if (value === undefined) {
      return panic(`${flag} requires a value`);
    }
    if (flag === "--version") {
      version = value;
    } else if (flag === "--base") {
      base = value;
    } else {
      return panic(`Unknown argument: ${flag}`);
    }
    index += 1;
  }
  return { version, base };
};

const main = async (args: readonly string[]): Promise<number> => {
  const { version: versionArg, base } = parseArgs(args);
  const version = versionArg ?? readVersionFile(REPO_ROOT);

  if (base !== null) {
    const previous = run(["git", "show", `${base}:${VERSION_FILE}`], REPO_ROOT);
    if (previous.ok && previous.stdout.trim() === version) {
      return report({
        status: "not-a-release",
        reason: `${VERSION_FILE} unchanged against ${base}`,
      });
    }
  }

  const classification = classifyCliRelease({
    version,
    cliVersion: readCliVersion(REPO_ROOT),
    pendingCliChangesets: readPendingCliChangesets(REPO_ROOT),
    published: STABLE_VERSION_PATTERN.test(version)
      ? readPublishedCli()
      : { latest: "0.0.0", versions: [] },
  });
  const verdict = verdictFromClassification(classification);
  if (verdict.status !== "unchanged") {
    return report(verdict);
  }

  const drift = findSurfaceDrift({
    head: readHeadSurface(REPO_ROOT),
    published: await readPublishedSurface(verdict.cliVersion),
  });
  if (drift.length === 0) {
    return report(verdict);
  }
  return report({
    status: "blocked",
    message: `the commit carries ${CLI_PACKAGE_NAME}@${verdict.cliVersion}, the published version, but its contract surface differs from the published tarball (${drift.join(", ")}). Add a changeset so the CLI ships under a new version with this release.`,
  });
};

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
