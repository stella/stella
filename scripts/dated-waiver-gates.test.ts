import { expect, test } from "bun:test";

import {
  extensionProposalFailures,
  prematureExclusionRemovals,
  type DatedWaiver,
  waiverKey,
} from "./dated-waivers";

const expiresAt = "2026-10-18T12:00:00.000Z";
const bunfig = `[install]\nminimumReleaseAgeExcludes = [\n  "bun-types", # quarantine-expires: ${expiresAt}\n]\n`;

test("release-age removal is blocked in every carrying file until the exact expiry", () => {
  const files = { "bunfig.toml": bunfig, ".claude/mcp/bunfig.toml": bunfig };
  for (const retained of [files, { "bunfig.toml": bunfig }, {}]) {
    const errors = prematureExclusionRemovals(
      files,
      retained,
      new Date(Date.parse(expiresAt) - 1),
    );
    expect(errors).toHaveLength(2 - Object.keys(retained).length);
    expect(
      prematureExclusionRemovals(files, retained, new Date(expiresAt)),
    ).toEqual([]);
  }
  expect(
    prematureExclusionRemovals(
      files,
      {
        "bunfig.toml": bunfig.replace(expiresAt, "2026-10-20T12:00:00.000Z"),
        ".claude/mcp/bunfig.toml": bunfig,
      },
      new Date("2026-10-15T12:00:00.000Z"),
    ),
  ).toEqual([]);
});

const entry = {
  kind: "dependency-audit",
  source: "scripts/dependency-audit-baseline.json",
  id: "GHSA-fixture",
  expiresAt,
  line: 1,
  probe: { command: ["bun", "audit"], attempts: 3 },
} satisfies DatedWaiver;
const proposalFile = `.github/dated-exception-proposals/${waiverKey(entry)}.json`;
const proposal = (ownerReason: string) => ({
  [proposalFile]: JSON.stringify({
    schemaVersion: 1,
    kind: "extension",
    entries: [entry],
    ownerReason,
  }),
});

test("extension placeholders and unchanged deadlines cannot pass the required check", () => {
  for (const reason of [
    "OWNER_REASON_REQUIRED",
    "REQUIRED",
    "TODO",
    "TBD",
    "",
    "placeholder",
  ]) {
    expect(
      extensionProposalFailures({
        proposals: proposal(reason),
        entries: [entry],
      }).some((failure) => failure.includes("explicit owner reason")),
    ).toBe(true);
  }
  const reason = "The upstream correction is still under review.";
  expect(
    extensionProposalFailures({
      proposals: proposal(reason),
      entries: [entry],
    }),
  ).toContain(
    `${proposalFile}: owner must resolve the exception or explicitly change its expiry`,
  );
  const renewed = [{ ...entry, expiresAt: "2026-10-20T12:00:00.000Z" }];
  expect(
    extensionProposalFailures({
      proposals: proposal(reason),
      entries: renewed,
      body: `owner-reason: ${reason}`,
    }),
  ).toEqual([]);
  expect(
    extensionProposalFailures({
      proposals: proposal(reason),
      entries: renewed,
      body: "owner-reason: OWNER_REASON_REQUIRED",
    }),
  ).toHaveLength(1);
  expect(
    extensionProposalFailures({ proposals: proposal(reason), entries: [] }),
  ).toEqual([]);
});

test("extension references stay bound to their proposal and owning source", () => {
  const reason = "The upstream correction is still under review.";
  const proposals = proposal(reason);
  const original = JSON.parse(proposals[proposalFile] ?? "");
  const scope = {
    type: "changes",
    changedFiles: new Set([proposalFile]),
  } as const;
  for (const changes of [
    { id: "another-entry" },
    { source: "another.json" },
    { kind: "suppression-waiver" },
    { expiresAt: "2026-10-17T12:00:00.000Z" },
  ]) {
    const edited = {
      [proposalFile]: JSON.stringify({
        ...original,
        entries: [{ ...entry, ...changes }],
      }),
    };
    expect(
      extensionProposalFailures({ proposals: edited, entries: [entry], scope }),
    ).not.toEqual([]);
    expect(
      extensionProposalFailures({
        proposals: edited,
        entries: [],
        scope,
        baseProposals: proposals,
      }),
    ).not.toEqual([]);
  }
  expect(
    extensionProposalFailures({ proposals, entries: [], scope }),
  ).not.toEqual([]);
  const resolved = {
    type: "changes",
    changedFiles: new Set([proposalFile, entry.source]),
  } as const;
  expect(
    extensionProposalFailures({
      proposals,
      entries: [],
      scope: resolved,
      baseEntries: [entry],
    }),
  ).toEqual([]);
  expect(
    extensionProposalFailures({
      proposals,
      entries: [],
      scope,
      baseProposals: proposals,
    }),
  ).toEqual([]);
  const renewed = [{ ...entry, expiresAt: "2026-10-20T12:00:00.000Z" }];
  expect(
    extensionProposalFailures({ proposals, entries: renewed, scope }),
  ).not.toEqual([]);
  expect(
    extensionProposalFailures({
      proposals,
      entries: renewed,
      scope: resolved,
      baseEntries: [entry],
    }),
  ).toEqual([]);
});

test("a new extension must reference the deadline the base inventory records", () => {
  const reason = "The upstream correction is still under review.";
  const original = JSON.parse(proposal(reason)[proposalFile] ?? "");
  const forgedExpiry = "2026-10-20T12:00:00.000Z";
  // The owner leaves the deadline unchanged, edits the owning source, and
  // records a different deadline in the new proposal.
  const forged = {
    [proposalFile]: JSON.stringify({
      ...original,
      entries: [{ ...original.entries[0], expiresAt: forgedExpiry }],
    }),
  };
  const sourceEdited = {
    type: "changes",
    changedFiles: new Set([proposalFile, entry.source]),
  } as const;
  expect(
    extensionProposalFailures({
      proposals: forged,
      entries: [entry],
      scope: sourceEdited,
      baseEntries: [entry],
    }),
  ).toEqual([
    `${proposalFile}: a new extension must reference its base inventory deadline`,
  ]);
  // Without the base inventory a new proposal cannot be verified at all.
  expect(
    extensionProposalFailures({
      proposals: proposal(reason),
      entries: [],
      scope: sourceEdited,
    }),
  ).toEqual([
    `${proposalFile}: a new extension must reference its base inventory deadline`,
  ]);
});

test("an applied extension can be renewed through the same proposal record", () => {
  const at = (deadline: string) => ({ ...entry, expiresAt: deadline });
  const record = (reference: DatedWaiver, ownerReason: string) => ({
    [proposalFile]: JSON.stringify({
      schemaVersion: 1,
      kind: "extension",
      entries: [reference],
      ownerReason,
    }),
  });
  const firstDeadline = expiresAt;
  const renewedDeadline = "2026-10-25T12:00:00.000Z";
  const nextDeadline = "2026-11-01T12:00:00.000Z";
  // The first extension moved the deadline to renewedDeadline; the radar now
  // proposes extending that one, and the owner moves it to nextDeadline.
  const baseProposals = record(
    at(firstDeadline),
    "The upstream correction is still under review.",
  );
  const renewed = record(
    at(renewedDeadline),
    "The upstream release slipped by another week.",
  );
  const sourceChanged = new Set([proposalFile, entry.source]);
  const renew = ({
    proposals = renewed,
    baseEntries,
    changedFiles = sourceChanged,
  }: {
    proposals?: Record<string, string>;
    baseEntries: DatedWaiver[] | null;
    changedFiles?: Set<string>;
  }) =>
    extensionProposalFailures({
      proposals,
      entries: [at(nextDeadline)],
      scope: { type: "changes", changedFiles },
      baseProposals,
      baseEntries,
    });
  const immutable = `${proposalFile}: extension entries are immutable until that extension is applied`;
  const unbound = `${proposalFile}: a new extension must reference its base inventory deadline`;

  expect(renew({ baseEntries: [at(renewedDeadline)] })).toEqual([]);
  // The first extension was never applied: its record stays as it is.
  expect(renew({ baseEntries: [at(firstDeadline)] })).toContain(immutable);
  // Without the base inventory a renewal cannot be verified.
  expect(renew({ baseEntries: null })).toContain(immutable);
  // The renewal must reference the deadline the base inventory records.
  expect(
    renew({
      proposals: record(
        at("2026-10-28T12:00:00.000Z"),
        "The upstream release slipped by another week.",
      ),
      baseEntries: [at(renewedDeadline)],
    }),
  ).toContain(unbound);
  // The earlier owner reason does not excuse a renewal from changing the
  // owning source.
  expect(
    renew({
      baseEntries: [at(renewedDeadline)],
      changedFiles: new Set([proposalFile]),
    }),
  ).toContain(
    `${proposalFile}: resolving an extension requires a change to its owning source`,
  );
});
