import { panic } from "better-result";

import type { BaselineEntry } from "./dependency-audit";
import type {
  AdvisoryAssessment,
  InstallableRelease,
} from "./dependency-audit-assessment";

export type DependencyAuditRemediationPlan = {
  pins: ReadonlyMap<string, string>;
  quarantineExclusions: readonly {
    package: string;
    version: string;
    quarantineExpires: string;
  }[];
  acceptanceDrafts: readonly BaselineEntry[];
};

type ResolvedRemediation = {
  assessments: readonly AdvisoryAssessment[];
  beforeLockfile: string;
  afterLockfile: string;
  revert: () => Promise<void>;
};

type VerifyRemediationOptions = PlanRemediationOptions & {
  resolve: (
    plan: DependencyAuditRemediationPlan,
  ) => Promise<ResolvedRemediation>;
};

const isPackageWideResolution = (name: string): boolean =>
  resolutionSegments(name).length === 1;

// Bun resolution paths use `/` both between packages and inside scoped names.
// Parse them before comparing so `example` never aliases `@vendor/example`.
const resolutionSegments = (resolution: string): string[] => {
  const segments: string[] = [];
  const parts = resolution.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part?.startsWith("@")) {
      const name = parts[index + 1];
      if (name !== undefined) {
        segments.push(`${part}/${name}`);
        index += 1;
      }
    } else if (part !== undefined && part !== "") {
      segments.push(part);
    }
  }
  return segments;
};

export const updatedResolutionEntries = (
  current: Readonly<Record<string, unknown>>,
  pins: ReadonlyMap<string, string>,
): Record<string, unknown> => {
  const packageWide = [...pins.keys()].filter(isPackageWideResolution);
  return Object.fromEntries([
    ...Object.entries(current).filter(([existing]) =>
      packageWide.every((name) => {
        const segments = resolutionSegments(existing);
        return segments.length === 1 || segments.at(-1) !== name;
      }),
    ),
    ...pins,
  ]);
};

type PlanRemediationOptions = {
  assessments: readonly AdvisoryAssessment[];
  now: Date;
};

const expiryDate = (now: Date): string => {
  const expiry = new Date(now);
  expiry.setUTCDate(expiry.getUTCDate() + 14);
  return expiry.toISOString().slice(0, 10);
};

const acceptanceDraft = (
  assessment: AdvisoryAssessment,
  now: Date,
): BaselineEntry => ({
  id: assessment.advisory.id,
  severity: assessment.advisory.severity,
  package: assessment.advisory.package,
  title: assessment.advisory.title,
  owner: "supply-chain",
  reason:
    "A patched release is not currently selectable; review the dependency path before this acceptance expires.",
  expiresOn: expiryDate(now),
  affectedPaths: assessment.affectedPaths,
});

const accepts = (version: string, requirement: string): boolean =>
  Bun.semver.satisfies(version, requirement);

const candidateVersions = (assessment: AdvisoryAssessment): string[] => {
  switch (assessment.disposition.status) {
    case "fix_available":
      return [
        ...assessment.disposition.installableVersions,
        ...assessment.disposition.quarantinedVersions.map(
          ({ version }) => version,
        ),
      ];
    case "fix_in_quarantine":
      return assessment.disposition.quarantinedVersions.map(
        ({ version }) => version,
      );
    case "pinned_resolution_blocked":
    case "upstream_blocked":
      return assessment.disposition.patchedVersions;
    case "accepted":
      return [];
    default:
      assessment.disposition satisfies never;
      return panic("Unhandled dependency audit remediation disposition");
  }
};

const quarantinedCandidates = (
  assessments: readonly AdvisoryAssessment[],
): Map<string, InstallableRelease> =>
  new Map(
    assessments.flatMap(({ disposition }) =>
      disposition.status === "fix_available" ||
      disposition.status === "fix_in_quarantine"
        ? disposition.quarantinedVersions.map(
            (release) => [release.version, release] as const,
          )
        : [],
    ),
  );

export const planDependencyAuditRemediation = ({
  assessments,
  now,
}: PlanRemediationOptions): DependencyAuditRemediationPlan => {
  const pins = new Map<string, string>();
  const quarantineExclusions: {
    package: string;
    version: string;
    quarantineExpires: string;
  }[] = [];
  const acceptanceDrafts: BaselineEntry[] = [];

  const groups = Map.groupBy(assessments, ({ advisory }) => advisory.package);
  for (const [packageName, group] of groups) {
    const actionable = group.filter(
      ({ disposition }) =>
        disposition.status === "fix_available" ||
        disposition.status === "fix_in_quarantine",
    );
    const blocked = group.some(
      ({ disposition }) =>
        disposition.status !== "fix_available" &&
        disposition.status !== "fix_in_quarantine" &&
        disposition.status !== "accepted",
    );
    const candidates = new Set(actionable.flatMap(candidateVersions));
    const common = [...candidates]
      .filter((version) =>
        actionable.every(
          ({ advisory }) =>
            !Bun.semver.satisfies(version, advisory.vulnerableVersions),
        ),
      )
      .filter((version) =>
        actionable.every((assessment) =>
          candidateVersions(assessment).includes(version),
        ),
      )
      .toSorted((left, right) => {
        const acceptedFixedByLeft = group.filter(
          ({ advisory, disposition }) =>
            disposition.status === "accepted" &&
            !Bun.semver.satisfies(left, advisory.vulnerableVersions),
        ).length;
        const acceptedFixedByRight = group.filter(
          ({ advisory, disposition }) =>
            disposition.status === "accepted" &&
            !Bun.semver.satisfies(right, advisory.vulnerableVersions),
        ).length;
        return (
          acceptedFixedByRight - acceptedFixedByLeft ||
          Bun.semver.order(left, right)
        );
      });
    const quarantined = quarantinedCandidates(actionable);
    const installable = common.find((version) => !quarantined.has(version));
    const selected = installable ?? common.at(0);

    if (!blocked && actionable.length > 0 && selected !== undefined) {
      const remediated = group.filter(
        ({ advisory }) =>
          !Bun.semver.satisfies(selected, advisory.vulnerableVersions),
      );
      const affectedCopies = new Set(
        remediated.flatMap(({ affectedPaths }) => affectedPaths),
      );
      const copies = new Map(
        group.flatMap(({ copies: assessmentCopies }) =>
          assessmentCopies.map((copy) => [copy.path, copy] as const),
        ),
      );
      const resolutionPaths = new Map(
        group.flatMap(({ resolutionPaths: assessmentPaths }) =>
          assessmentPaths.map((path) => [path.copyPath, path] as const),
        ),
      );
      const everyCopyIsVulnerable = [...copies].every(([path]) =>
        affectedCopies.has(path),
      );
      const packageWideIsValid =
        everyCopyIsVulnerable &&
        [...resolutionPaths.values()].every(
          ({ repositoryResolution }) => repositoryResolution !== true,
        ) &&
        [...resolutionPaths.values()].every(({ requirement }) =>
          accepts(selected, requirement),
        );
      const scopedPaths = [...resolutionPaths.values()].filter(({ copyPath }) =>
        affectedCopies.has(copyPath),
      );
      const scopedWriteIsValid =
        scopedPaths.length > 0 &&
        affectedCopies.size ===
          new Set(scopedPaths.map(({ copyPath }) => copyPath)).size &&
        scopedPaths.every(({ requirement }) => accepts(selected, requirement));

      if (packageWideIsValid) {
        pins.set(packageName, selected);
      } else if (scopedWriteIsValid) {
        for (const { resolution } of scopedPaths) {
          pins.set(resolution, selected);
        }
      } else {
        for (const assessment of group) {
          if (assessment.acceptance === undefined) {
            acceptanceDrafts.push(acceptanceDraft(assessment, now));
          }
        }
        continue;
      }
      const quarantinedRelease = quarantined.get(selected);
      if (quarantinedRelease !== undefined) {
        quarantineExclusions.push({
          package: packageName,
          version: selected,
          quarantineExpires: quarantinedRelease.installableSince,
        });
      }
      continue;
    }

    for (const assessment of group) {
      if (
        assessment.acceptance === undefined &&
        assessment.disposition.status !== "accepted" &&
        assessment.disposition.status !== "pinned_resolution_blocked"
      ) {
        acceptanceDrafts.push(acceptanceDraft(assessment, now));
      }
    }
  }

  return { pins, quarantineExclusions, acceptanceDrafts };
};

const advisoryKey = ({ advisory }: AdvisoryAssessment): string =>
  `${advisory.id}/${advisory.package}`;

type LockedCopy = {
  name: string;
  version: string;
  details: Record<string, unknown>;
};

const lockfileCopies = (lockfile: string): Map<string, LockedCopy> => {
  const parsed: unknown = Bun.JSONC.parse(lockfile);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new Map();
  }
  const packages = Reflect.get(parsed, "packages");
  if (
    typeof packages !== "object" ||
    packages === null ||
    Array.isArray(packages)
  ) {
    return new Map();
  }
  return new Map(
    Object.entries(packages).flatMap(([path, entry]) => {
      if (!Array.isArray(entry) || typeof entry.at(0) !== "string") {
        return [];
      }
      const resolution = entry.at(0);
      const separator = resolution.indexOf(
        "@",
        resolution.startsWith("@") ? 1 : 0,
      );
      const details = entry.at(2);
      return [
        [
          path,
          {
            name: resolution.slice(0, separator),
            version: resolution.slice(separator + 1),
            details:
              typeof details === "object" &&
              details !== null &&
              !Array.isArray(details)
                ? details
                : {},
          },
        ] as const,
      ];
    }),
  );
};

type SafeCopyChangesOptions = {
  beforeLockfile: string;
  afterLockfile: string;
  targetedCopies: ReadonlySet<string>;
  requirements: ReadonlyMap<string, readonly string[]>;
  plannedResolutions: ReadonlyMap<string, string>;
};

const changedCopiesAreSafe = ({
  beforeLockfile,
  afterLockfile,
  targetedCopies,
  requirements,
  plannedResolutions,
}: SafeCopyChangesOptions): boolean => {
  const before = lockfileCopies(beforeLockfile);
  const after = lockfileCopies(afterLockfile);
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of paths) {
    const oldCopy = before.get(path);
    const newCopy = after.get(path);
    if (oldCopy?.version === newCopy?.version) {
      continue;
    }
    if (
      oldCopy === undefined ||
      newCopy === undefined ||
      oldCopy.name !== newCopy.name ||
      !targetedCopies.has(path)
    ) {
      return false;
    }
    if (
      requirements
        .get(path)
        ?.some((requirement) => !accepts(newCopy.version, requirement)) === true
    ) {
      return false;
    }
    const plannedResolution = plannedResolutions.get(path);
    if (plannedResolution !== undefined) {
      if (newCopy.version !== plannedResolution) {
        return false;
      }
      continue;
    }
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      for (const [parentPath, parent] of before) {
        const dependencies = parent.details[field];
        if (
          typeof dependencies !== "object" ||
          dependencies === null ||
          Array.isArray(dependencies)
        ) {
          continue;
        }
        const requirement = Reflect.get(dependencies, oldCopy.name);
        if (typeof requirement !== "string") {
          continue;
        }
        const parentSegments = resolutionSegments(parentPath);
        const candidates = parentSegments.map(
          (_, index) =>
            `${parentSegments.slice(0, parentSegments.length - index).join("/")}/${oldCopy.name}`,
        );
        if (
          candidates.includes(path) &&
          !accepts(newCopy.version, requirement)
        ) {
          return false;
        }
      }
    }
  }
  return true;
};

/**
 * Lets Bun decide whether each package-level proposal is valid. The resolver
 * owns the filesystem transaction and supplies a rollback for a rejected
 * proposal; process and registry failures reject instead of becoming drafts.
 */
export const verifyDependencyAuditRemediation = async ({
  assessments,
  now,
  resolve,
}: VerifyRemediationOptions): Promise<DependencyAuditRemediationPlan> => {
  const pins = new Map<string, string>();
  const quarantineExclusions: DependencyAuditRemediationPlan["quarantineExclusions"][number][] =
    [];
  const acceptanceDrafts: BaselineEntry[] = [];
  const initial = new Set(assessments.map(advisoryKey));

  for (const group of Map.groupBy(
    assessments,
    ({ advisory }) => advisory.package,
  ).values()) {
    const proposal = planDependencyAuditRemediation({
      assessments: group,
      now,
    });
    if (proposal.pins.size === 0) {
      acceptanceDrafts.push(...proposal.acceptanceDrafts);
      continue;
    }

    const resolved = await resolve(proposal);
    const remaining = new Set(resolved.assessments.map(advisoryKey));
    const targets = new Set(
      group
        .filter(
          ({ disposition }) =>
            disposition.status === "fix_available" ||
            disposition.status === "fix_in_quarantine",
        )
        .map(advisoryKey),
    );
    const targetRemains = [...targets].some((key) => remaining.has(key));
    const introducedAdvisory = [...remaining].some((key) => !initial.has(key));
    const lockfileChangesAreSafe = changedCopiesAreSafe({
      beforeLockfile: resolved.beforeLockfile,
      afterLockfile: resolved.afterLockfile,
      targetedCopies: new Set(
        group.flatMap(({ affectedPaths }) => affectedPaths),
      ),
      requirements: new Map(
        group.flatMap(({ resolutionPaths }) =>
          resolutionPaths.map(
            ({ copyPath }) =>
              [
                copyPath,
                resolutionPaths
                  .filter((path) => path.copyPath === copyPath)
                  .map(({ requirement }) => requirement),
              ] as const,
          ),
        ),
      ),
      plannedResolutions: new Map(
        group.flatMap(({ resolutionPaths }) =>
          resolutionPaths.flatMap(
            ({ copyPath, repositoryResolution, resolution }) => {
              if (repositoryResolution !== true) {
                return [];
              }
              const planned = proposal.pins.get(resolution);
              return planned === undefined
                ? []
                : ([[copyPath, planned]] as const);
            },
          ),
        ),
      ),
    });
    if (targetRemains || introducedAdvisory || !lockfileChangesAreSafe) {
      await resolved.revert();
      acceptanceDrafts.push(
        ...group.flatMap((assessment) =>
          assessment.acceptance === undefined
            ? [acceptanceDraft(assessment, now)]
            : [],
        ),
      );
      continue;
    }

    for (const [name, version] of proposal.pins) {
      pins.set(name, version);
    }
    quarantineExclusions.push(...proposal.quarantineExclusions);
  }

  return { pins, quarantineExclusions, acceptanceDrafts };
};
