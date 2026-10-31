import { panic } from "better-result";

import type { BaselineEntry } from "./dependency-audit";
import type { AdvisoryAssessment } from "./dependency-audit-assessment";

export type DependencyAuditRemediationPlan = {
  pins: ReadonlyMap<string, string>;
  quarantineExclusions: readonly {
    package: string;
    version: string;
    quarantineExpires: string;
  }[];
  acceptanceDrafts: readonly BaselineEntry[];
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

  for (const assessment of assessments) {
    const { advisory, disposition } = assessment;
    switch (disposition.status) {
      case "fix_available": {
        const version = disposition.patchedVersions.at(0);
        if (version !== undefined) {
          pins.set(advisory.package, version);
        }
        break;
      }
      case "fix_in_quarantine": {
        pins.set(advisory.package, disposition.version);
        quarantineExclusions.push({
          package: advisory.package,
          version: disposition.version,
          quarantineExpires: disposition.installableSince,
        });
        break;
      }
      case "upstream_blocked":
        if (assessment.acceptance === undefined) {
          acceptanceDrafts.push({
            id: advisory.id,
            severity: advisory.severity,
            package: advisory.package,
            title: advisory.title,
            owner: "supply-chain",
            reason:
              "A patched release is not currently selectable; review the dependency path before this acceptance expires.",
            expiresOn: expiryDate(now),
            affectedPaths: assessment.affectedPaths,
          });
        }
        break;
      case "accepted":
      case "pinned_resolution_blocked":
        break;
      default:
        disposition satisfies never;
        panic("Unhandled dependency audit remediation disposition");
    }
  }

  return { pins, quarantineExclusions, acceptanceDrafts };
};
