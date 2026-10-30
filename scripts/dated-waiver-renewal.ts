// A documentation waiver asserts that a dependency publishes no llms.txt. When
// healing finds that assertion still true on every sample, it renews the
// waiver on main in one proposal instead of leaving the date to whichever
// change next touches the owner file. Every other kind, and any probe that
// could not confirm absence, keeps its deadline.
import { panic } from "better-result";

import type { StringLiteral } from "../packages/scripts/src/syntax-tree";
import type { FixEvidence } from "./dated-waiver-fix-task";
import {
  type DocumentationSite,
  readDocumentationOwner,
} from "./dated-waiver-probes";
import {
  type DatedWaiver,
  DAY_MS,
  DOC_SOURCE_FILE,
  expiryInstant,
} from "./dated-waivers";

// The owner policy allows at most 31 days between check and expiry.
export const RENEWAL_DAYS = 30;

export type RenewalDates = { checkedAt: string; expiresAt: string };

/** The check is recorded at the start of its UTC day, like hand renewals. */
export const renewalDates = (now: Date): RenewalDates => {
  const checked = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return {
    checkedAt: new Date(checked).toISOString(),
    expiresAt: new Date(checked + RENEWAL_DAYS * DAY_MS).toISOString(),
  };
};

export type RenewalPlan = {
  dates: RenewalDates;
  renewed: DatedWaiver[];
  // Absent entries that cannot be renewed alone: their dates are shared with
  // an entry that was not confirmed absent, or their dates are not literals.
  held: DatedWaiver[];
  files: Record<string, string>;
  baseFiles: Record<string, string>;
};

const sharedDateGroups = (sites: readonly DocumentationSite[]) => {
  const parents = new Map(sites.map((site) => [site, site]));
  const root = (site: DocumentationSite): DocumentationSite => {
    const parent = parents.get(site);
    if (parent === undefined) {
      return panic("Documentation date group missing");
    }
    if (parent === site) {
      return site;
    }
    const owner = root(parent);
    parents.set(site, owner);
    return owner;
  };
  const literalOwners = new Map<number, DocumentationSite>();
  for (const site of sites) {
    for (const literal of [site.checkedAt, site.expiresAt]) {
      if (literal === undefined) {
        continue;
      }
      const owner = literalOwners.get(literal.start);
      if (owner === undefined) {
        literalOwners.set(literal.start, site);
        continue;
      }
      parents.set(root(site), root(owner));
    }
  }
  const groups = new Map<DocumentationSite, DocumentationSite[]>();
  for (const site of sites) {
    const owner = root(site);
    const members = groups.get(owner);
    if (members === undefined) {
      groups.set(owner, [site]);
      continue;
    }
    members.push(site);
  }
  return new Map(
    sites.map((site) => {
      const group = groups.get(root(site));
      if (group === undefined) {
        return panic("Documentation date group missing");
      }
      return [site, group] as const;
    }),
  );
};

type PlanRenewalOptions = {
  source: string;
  absent: readonly DatedWaiver[];
  now: Date;
};

export const planDocRenewal = ({
  source,
  absent,
  now,
}: PlanRenewalOptions): RenewalPlan => {
  const dates = renewalDates(now);
  const { sites } = readDocumentationOwner(source);
  const groups = sharedDateGroups(sites);
  const candidates = new Map<
    DatedWaiver,
    {
      site: DocumentationSite;
      checkedAt: StringLiteral;
      expiresAt: StringLiteral;
    }
  >();
  for (const entry of absent) {
    const matches = sites.filter(({ dependency }) => dependency === entry.id);
    const site = matches.at(0);
    if (
      entry.kind !== "no-llms-txt" ||
      entry.source !== DOC_SOURCE_FILE ||
      now.getTime() >= Date.parse(expiryInstant(entry.expiresAt)) ||
      matches.length !== 1 ||
      site?.checkedAt === undefined ||
      site.expiresAt === undefined ||
      site.expiresAt.value !== entry.expiresAt ||
      site.checkedAt.value !== entry.checkedAt
    ) {
      continue;
    }
    candidates.set(entry, {
      site,
      checkedAt: site.checkedAt,
      expiresAt: site.expiresAt,
    });
  }
  const eligible = new Set([...candidates.values()].map(({ site }) => site));
  const replacements = new Map<
    number,
    { literal: StringLiteral; value: string }
  >();
  const renewed: DatedWaiver[] = [];
  const held: DatedWaiver[] = [];
  for (const entry of absent) {
    const candidate = candidates.get(entry);
    if (candidate === undefined) {
      held.push(entry);
      continue;
    }
    const group = groups.get(candidate.site);
    if (group === undefined) {
      panic("Documentation date group missing");
    }
    if (!group.every((site) => eligible.has(site))) {
      held.push(entry);
      continue;
    }
    replacements.set(candidate.checkedAt.start, {
      literal: candidate.checkedAt,
      value: dates.checkedAt,
    });
    replacements.set(candidate.expiresAt.start, {
      literal: candidate.expiresAt,
      value: dates.expiresAt,
    });
    renewed.push(entry);
  }
  let after = source;
  for (const { literal, value } of [...replacements.values()].toSorted(
    (left, right) => right.literal.start - left.literal.start,
  )) {
    after = `${after.slice(0, literal.start)}${JSON.stringify(value)}${after.slice(literal.end)}`;
  }
  readDocumentationOwner(after);
  return {
    dates,
    renewed,
    held,
    files: renewed.length > 0 ? { [DOC_SOURCE_FILE]: after } : {},
    baseFiles: renewed.length > 0 ? { [DOC_SOURCE_FILE]: source } : {},
  };
};

export type RenewalRecord = { entry: DatedWaiver; evidence: FixEvidence };

// Public proposal text: counts, probed URLs and provenance only. Captured
// probe output stays private like every other healing evidence.
export const renderRenewalEvidence = (
  records: readonly RenewalRecord[],
  dates: RenewalDates,
): string =>
  [
    "Renew documentation waivers whose canonical llms.txt is still absent.",
    "",
    `Checked: ${dates.checkedAt}. Expires: ${dates.expiresAt}.`,
    "",
    ...records.map(
      ({ entry, evidence }) =>
        `- ${entry.id}: ${evidence.command.at(3) ?? "no URL"} absent on ${evidence.attempts}/${entry.probe.attempts} samples.`,
    ),
    "",
    `Runner: ${records.at(0)?.evidence.runner ?? "unknown"}.`,
    `Commit: ${records.at(0)?.evidence.sha ?? "unknown"}.`,
    `Evidence: ${records.at(0)?.evidence.run ?? "unknown"}.`,
  ].join("\n");
