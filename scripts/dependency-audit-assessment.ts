// One assessment per advisory, including every vulnerable lockfile resolution.
import { panic, Result, TaggedError } from "better-result";

import type { Advisory, BaselineEntry } from "./dependency-audit";

export class AuditAssessmentError extends TaggedError("AuditAssessmentError")<{
  message: string;
}> {}

const invalidAssessment = (message: string): never => {
  throw new AuditAssessmentError({ message });
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type AuditDisposition =
  | { status: "fix_available"; patchedVersions: string[] }
  | {
      status: "pinned_resolution_blocked";
      pins: string[];
      patchedVersions: string[];
    }
  | {
      status: "upstream_blocked";
      blockers: string[];
      patchedVersions: string[];
    }
  | { status: "accepted"; acceptance: BaselineEntry };

export type AdvisoryAssessment = {
  advisory: Advisory;
  disposition: AuditDisposition;
  acceptance: BaselineEntry | undefined;
  action: string;
};

type AssessAdvisoriesOptions = {
  advisories: readonly Advisory[];
  accepted: readonly BaselineEntry[];
  lockfile: string;
  manifest: unknown;
  versions: ReadonlyMap<string, readonly string[]>;
};

const splitResolution = (resolution: string) => {
  const separator = resolution.indexOf("@", resolution.startsWith("@") ? 1 : 0);
  return {
    name: resolution.slice(0, separator),
    version: resolution.slice(separator + 1),
  };
};

const lockPackages = (lockfile: string) => {
  const parsed: unknown = Bun.JSONC.parse(lockfile);
  if (!record(parsed) || !record(parsed["packages"])) {
    return invalidAssessment(
      "Dependency assessment requires a bun.lock packages object",
    );
  }
  return Object.entries(parsed["packages"]).map(([key, value]) => {
    if (!Array.isArray(value) || typeof value.at(0) !== "string") {
      return invalidAssessment(`Invalid lockfile package ${key}`);
    }
    const details: unknown = value.at(2);
    return {
      key,
      ...splitResolution(value.at(0)),
      details: record(details) ? details : {},
    };
  });
};

// Match Bun's nested package keys rather than attributing a hoisted patched
// copy to a parent that actually resolves a nested vulnerable copy.
type ResolvedKeyOptions = {
  parent: string;
  dependency: string;
  keys: ReadonlySet<string>;
};
const resolvedKey = ({
  parent,
  dependency,
  keys,
}: ResolvedKeyOptions): string | undefined => {
  const locations = parent.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [];
  while (locations.length > 0) {
    const candidate = `${locations.join("/")}/${dependency}`;
    if (keys.has(candidate)) {
      return candidate;
    }
    locations.pop();
  }
  return keys.has(dependency) ? dependency : undefined;
};

// The root manifest plus every workspace manifest bun.lock records. Each one
// owns the copy its name resolves to, as Bun nests `<workspace>/<package>`.
type ManifestSource = {
  owner: string;
  label: string;
  manifest: Record<string, unknown>;
};
const manifestSources = (
  manifest: unknown,
  lockfile: string,
): ManifestSource[] => {
  const parsed: unknown = Bun.JSONC.parse(lockfile);
  const workspaces =
    record(parsed) && record(parsed["workspaces"]) ? parsed["workspaces"] : {};
  return [
    {
      owner: "",
      label: "package.json",
      manifest: record(manifest) ? manifest : {},
    },
    ...Object.entries(workspaces).flatMap(([workspace, entry]) =>
      workspace === "" || !record(entry)
        ? []
        : [
            {
              owner:
                typeof entry["name"] === "string" ? entry["name"] : workspace,
              label: `${workspace}/package.json`,
              manifest: entry,
            },
          ],
    ),
  ];
};

// Requirement fields of a locked package and of a manifest that owns copies.
const PACKAGE_REQUIREMENT_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const OWNER_REQUIREMENT_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
// A manifest owner's requirement that excludes every forward patch of its copy
// is a pin we can lift; a locked package's requirement is an upstream blocker.
type RequirementOwner = {
  key: string;
  label: string;
  details: Record<string, unknown>;
  fields: readonly string[];
  manifest: boolean;
};

// Resolutions and overrides apply to every copy: one that admits no patched
// release is a pin.
const MANIFEST_REQUIREMENT_FIELDS = ["resolutions", "overrides"] as const;
type ManifestPinsOptions = {
  sources: readonly ManifestSource[];
  packageName: string;
  patchedVersions: readonly string[];
};
const manifestPins = ({
  sources,
  packageName,
  patchedVersions,
}: ManifestPinsOptions): string[] => {
  const pins: string[] = [];
  for (const { label, manifest } of sources) {
    for (const field of MANIFEST_REQUIREMENT_FIELDS) {
      const entries = manifest[field];
      const requirement = record(entries) ? entries[packageName] : undefined;
      if (typeof requirement !== "string") {
        continue;
      }
      if (
        !patchedVersions.some((version) =>
          Bun.semver.satisfies(version, requirement),
        )
      ) {
        pins.push(`${label} ${field}.${packageName}=${requirement}`);
      }
    }
  }
  return pins;
};

export const assessAdvisories = ({
  advisories,
  accepted,
  lockfile,
  manifest,
  versions,
}: AssessAdvisoriesOptions): AdvisoryAssessment[] => {
  const packages = lockPackages(lockfile);
  const keys = new Set(packages.map(({ key }) => key));
  const sources = manifestSources(manifest, lockfile);
  const owners: RequirementOwner[] = [
    ...packages.map(({ key, details }) => ({
      key,
      label: key,
      details,
      fields: PACKAGE_REQUIREMENT_FIELDS,
      manifest: false,
    })),
    ...sources.map(({ owner, label, manifest: details }) => ({
      key: owner,
      label,
      details,
      fields: OWNER_REQUIREMENT_FIELDS,
      manifest: true,
    })),
  ];
  return advisories.map((advisory) => {
    if (advisory.vulnerableVersions === "") {
      return invalidAssessment(
        `Cannot assess ${advisory.id}: advisory has no vulnerable range`,
      );
    }
    const published =
      versions.get(advisory.package) ??
      invalidAssessment(`Missing registry versions for ${advisory.package}`);
    const vulnerable = packages.filter(
      ({ name, version }) =>
        name === advisory.package &&
        Bun.semver.satisfies(version, advisory.vulnerableVersions),
    );
    if (vulnerable.length === 0) {
      return invalidAssessment(
        `Cannot assess ${advisory.id}: no vulnerable ${advisory.package} resolution in bun.lock`,
      );
    }
    // Recommend forward upgrades only: a safe older release is a downgrade,
    // not a patch. Each locked copy is judged against releases newer than it,
    // so an advisory spanning several release lines keeps each line's patch.
    const safeVersions = published.filter(
      (version) =>
        Bun.semver.satisfies(version, "*") &&
        !Bun.semver.satisfies(version, advisory.vulnerableVersions),
    );
    const upgradesFrom = (locked: string): string[] =>
      safeVersions.filter((version) => Bun.semver.order(version, locked) > 0);
    const oldestLocked =
      vulnerable
        .map(({ version }) => version)
        .toSorted(Bun.semver.order)
        .at(0) ??
      invalidAssessment(`Cannot find an affected version for ${advisory.id}`);
    const patchedVersions = upgradesFrom(oldestLocked);
    const acceptances = accepted.filter(
      ({ id, package: name }) =>
        id === advisory.id && name === advisory.package,
    );
    if (acceptances.length > 1) {
      return invalidAssessment(
        `Duplicate acceptance for ${advisory.id}/${advisory.package}`,
      );
    }
    const acceptance = acceptances.at(0);
    if (acceptance !== undefined) {
      if (acceptance.expiresOn === undefined) {
        return invalidAssessment(
          `Acceptance ${advisory.id} requires an expiry`,
        );
      }
      const uncovered = vulnerable.filter(
        ({ key }) => !acceptance.affectedPaths?.includes(key),
      );
      if (uncovered.length > 0) {
        return invalidAssessment(
          `Acceptance ${advisory.id} does not cover lockfile paths: ${uncovered.map(({ key }) => key).join(", ")}; review scripts/dependency-audit-baseline.json`,
        );
      }
    }
    const pins = manifestPins({
      sources,
      packageName: advisory.package,
      patchedVersions,
    });
    const blockers: string[] = [];
    for (const node of vulnerable) {
      const nodePatches = upgradesFrom(node.version);
      const parents: string[] = [];
      for (const parent of owners) {
        for (const field of parent.fields) {
          const dependencies = parent.details[field];
          const requirement = record(dependencies)
            ? dependencies[advisory.package]
            : undefined;
          if (
            typeof requirement !== "string" ||
            resolvedKey({
              parent: parent.key,
              dependency: advisory.package,
              keys,
            }) !== node.key
          ) {
            continue;
          }
          parents.push(
            `${parent.label} requires ${advisory.package} ${requirement}`,
          );
          if (
            nodePatches.some((version) =>
              Bun.semver.satisfies(version, requirement),
            )
          ) {
            continue;
          }
          if (parent.manifest && nodePatches.length > 0) {
            pins.push(
              `${parent.label} ${field}.${advisory.package}=${requirement}`,
            );
          } else {
            blockers.push(
              `${parent.label} requires ${advisory.package} ${requirement} (${node.key}@${node.version})`,
            );
          }
        }
      }
      // A copy nothing requires can still move within its major.
      if (
        parents.length === 0 &&
        !nodePatches.some(
          (version) =>
            version.split(".").at(0) === node.version.split(".").at(0),
        )
      ) {
        blockers.push(
          `${node.key}@${node.version}: no patched release in resolved major`,
        );
      }
    }
    let disposition: AuditDisposition;
    if (pins.length > 0 && patchedVersions.length > 0) {
      disposition = {
        status: "pinned_resolution_blocked",
        pins,
        patchedVersions,
      };
    } else if (blockers.length > 0 || patchedVersions.length === 0) {
      disposition = { status: "upstream_blocked", blockers, patchedVersions };
    } else if (acceptance !== undefined) {
      disposition = { status: "accepted", acceptance };
    } else {
      disposition = { status: "fix_available", patchedVersions };
    }
    const action = dispositionAction(disposition);
    return { advisory, disposition, acceptance, action };
  });
};

const dispositionAction = (disposition: AuditDisposition): string => {
  switch (disposition.status) {
    case "fix_available":
      return `Update the lockfile to a patched release: ${disposition.patchedVersions.slice(-3).join(", ")}`;
    case "pinned_resolution_blocked":
      return `Lift ${disposition.pins.join("; ")}; patched releases: ${disposition.patchedVersions.slice(-3).join(", ")}`;
    case "upstream_blocked":
      return `Upgrade the blocking parent or review a dated acceptance: ${disposition.blockers.join("; ") || "no patched release published"}`;
    case "accepted":
      return `Review acceptance by ${disposition.acceptance.expiresOn ?? "a required expiry"}: ${disposition.acceptance.reason}`;
    default:
      disposition satisfies never;
      return panic("Unhandled dependency audit disposition");
  }
};

export const printAssessments = (
  assessments: readonly AdvisoryAssessment[],
): void => {
  console.info("Advisory\tPackage\tState\tOwner\tExpiry\tAction");
  for (const { advisory, disposition, acceptance, action } of assessments) {
    console.info(
      [
        advisory.id,
        advisory.package,
        disposition.status,
        acceptance?.owner ?? "supply-chain",
        acceptance?.expiresOn ?? "MISSING acceptance",
        action,
      ].join("\t"),
    );
  }
};

// Use Bun's registry configuration, as audit does, with no manifest cache so
// a newly published compatible patch changes the assessment immediately.
export const readPublishedVersions = async (
  name: string,
): Promise<string[]> => {
  const result = await Result.tryPromise(async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "--no-env-file",
        "info",
        name,
        "versions",
        "--json",
        "--no-cache",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(30_000),
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return invalidAssessment(
        `Registry lookup failed for ${name}: ${stderr.trim()} (exit ${exitCode})`,
      );
    }
    const body: unknown = JSON.parse(stdout);
    if (
      !Array.isArray(body) ||
      !body.every((version): version is string => typeof version === "string")
    ) {
      return invalidAssessment(
        `Registry lookup for ${name} has no version list`,
      );
    }
    return body;
  });
  if (result.isErr()) {
    return invalidAssessment(`Cannot assess ${name}: ${String(result.error)}`);
  }
  return result.value;
};
