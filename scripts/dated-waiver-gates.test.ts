import { expect, test } from "bun:test";

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
const proposal = (ownerReason: string) => ({
  "proposal.json": JSON.stringify({
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
      extensionProposalFailures(proposal(reason), [entry]).some((failure) =>
        failure.includes("explicit owner reason"),
      ),
    ).toBe(true);
  }
  const reason = "The upstream correction is still under review.";
  expect(extensionProposalFailures(proposal(reason), [entry])).toContain(
    "proposal.json: owner must resolve the exception or explicitly change its expiry",
  );
  const renewed = [{ ...entry, expiresAt: "2026-10-20T12:00:00.000Z" }];
  expect(
    extensionProposalFailures(
      proposal(reason),
      renewed,
      `owner-reason: ${reason}`,
    ),
  ).toEqual([]);
  expect(
    extensionProposalFailures(
      proposal(reason),
      renewed,
      "owner-reason: OWNER_REASON_REQUIRED",
    ),
  ).toHaveLength(1);
  expect(extensionProposalFailures(proposal(reason), [])).toEqual([]);
});
