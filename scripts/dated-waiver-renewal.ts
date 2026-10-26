// A documentation waiver asserts that a dependency publishes no llms.txt. When
// healing finds that assertion still true on every sample, it renews the
// waiver on main in one proposal instead of leaving the date to whichever
// change next touches the owner file. Every other kind, and any probe that
// could not confirm absence, keeps its deadline.
import type ts from "typescript6";

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

type PlanRenewalOptions = {
  source: string;
  absent: readonly DatedWaiver[];
  now: Date;
};

const slotKey = (site: DocumentationSite): string | undefined =>
  site.checkedAt && site.expiresAt
    ? `${site.checkedAt.pos}:${site.expiresAt.pos}`
    : undefined;

export const planDocRenewal = ({
  source,
  absent,
  now,
}: PlanRenewalOptions): RenewalPlan => {
  const dates = renewalDates(now);
  const { ast, sites } = readDocumentationOwner(source);
  const confirmed = new Set(
    absent
      .filter(
        (entry) =>
          entry.kind === "no-llms-txt" &&
          entry.source === DOC_SOURCE_FILE &&
          now.getTime() < Date.parse(expiryInstant(entry.expiresAt)),
      )
      .map(({ id }) => id),
  );
  const members = new Map<string, DocumentationSite[]>();
  for (const site of sites) {
    const key = slotKey(site);
    if (key !== undefined) {
      members.set(key, [...(members.get(key) ?? []), site]);
    }
  }
  const replacements = new Map<
    number,
    { literal: ts.StringLiteral; value: string }
  >();
  const renewed: DatedWaiver[] = [];
  const held: DatedWaiver[] = [];
  for (const entry of absent) {
    const matches = sites.filter(({ dependency }) => dependency === entry.id);
    const site = matches.at(0);
    const key = site === undefined ? undefined : slotKey(site);
    const group = key === undefined ? [] : (members.get(key) ?? []);
    if (
      !confirmed.has(entry.id) ||
      matches.length !== 1 ||
      site?.checkedAt === undefined ||
      site.expiresAt === undefined ||
      site.expiresAt.text !== entry.expiresAt ||
      site.checkedAt.text !== entry.checkedAt ||
      !group.every(({ dependency }) => confirmed.has(dependency))
    ) {
      held.push(entry);
      continue;
    }
    replacements.set(site.checkedAt.pos, {
      literal: site.checkedAt,
      value: dates.checkedAt,
    });
    replacements.set(site.expiresAt.pos, {
      literal: site.expiresAt,
      value: dates.expiresAt,
    });
    renewed.push(entry);
  }
  let after = source;
  for (const { literal, value } of [...replacements.values()].toSorted(
    (left, right) => right.literal.pos - left.literal.pos,
  )) {
    after = `${after.slice(0, literal.getStart(ast))}${JSON.stringify(value)}${after.slice(literal.end)}`;
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
