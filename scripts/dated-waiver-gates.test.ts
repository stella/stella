import { expect, test } from "bun:test";

import { waiverKey } from "./dated-waiver-fix-task";
import {
  extensionProposalFailures,
  prematureExclusionRemovals,
  type DatedWaiver,
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
    extensionProposalFailures({ proposals, entries: [], scope: resolved }),
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
    extensionProposalFailures({ proposals, entries: renewed, scope: resolved }),
  ).toEqual([]);
});
