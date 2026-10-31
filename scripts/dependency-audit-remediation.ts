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
  revert: () => Promise<void>;
};

type VerifyRemediationOptions = PlanRemediationOptions & {
  resolve: (
    plan: DependencyAuditRemediationPlan,
  ) => Promise<ResolvedRemediation>;
};

const isPackageWideResolution = (name: string): boolean =>
  name.startsWith("@") ? name.split("/").length === 2 : !name.includes("/");

export const updatedResolutionEntries = (
  current: Readonly<Record<string, unknown>>,
  pins: ReadonlyMap<string, string>,
): Record<string, unknown> => {
  const packageWide = [...pins.keys()].filter(isPackageWideResolution);
  return Object.fromEntries([
    ...Object.entries(current).filter(([existing]) =>
      packageWide.every((name) => !existing.endsWith(`/${name}`)),
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
      ({ disposition }) => disposition.status === "upstream_blocked",
    );
    const candidates = new Set(actionable.flatMap(candidateVersions));
    const common = [...candidates]
      .filter((version) =>
        group.every(
          ({ advisory }) =>
            !Bun.semver.satisfies(version, advisory.vulnerableVersions),
        ),
      )
      .filter((version) =>
        actionable.every((assessment) =>
          candidateVersions(assessment).includes(version),
        ),
      )
      .toSorted(Bun.semver.order);
    const quarantined = quarantinedCandidates(actionable);
    const installable = common.find((version) => !quarantined.has(version));
    const selected = installable ?? common.at(0);

    if (
      !blocked &&
      actionable.length === group.length &&
      selected !== undefined
    ) {
      const affectedCopies = new Set(
        actionable.flatMap(({ affectedPaths }) => affectedPaths),
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
    const targets = new Set(group.map(advisoryKey));
    const targetRemains = [...targets].some((key) => remaining.has(key));
    const introducedAdvisory = [...remaining].some((key) => !initial.has(key));
    if (targetRemains || introducedAdvisory) {
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
