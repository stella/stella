import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { checkQuarantineExcludes } from "./check-stll-quarantine-excludes";
import {
  existingRadarProposal,
  extensionProposal,
  OWNER_REASON_REQUIRED,
  orphanRadarRemovals,
  publishRadar,
  radarAction,
  radarBody,
  radarFiles,
  radarProposalGroups,
  radarReuse,
  radarWriteNeeded,
  validateRadarRemoval,
} from "./dated-exception-radar";
import { removeWaiver } from "./dated-waiver-probes";
import {
  dueWaivers,
  prematureExclusionRemovals,
  type DatedWaiver,
} from "./dated-waivers";

const expiry = "2026-10-18T12:00:00.000Z";
const now = new Date("2026-10-15T12:00:00.000Z");
const entry = (source: string): DatedWaiver => ({
  source,
  line: 3,
  id: "bun-types",
  kind: "release-age-exclusion",
  expiresAt: expiry,
  probe: { command: ["bun", "check"], attempts: 3 },
});
const fixture = `[install]\nminimumReleaseAgeExcludes = [\n  "bun-types", # quarantine-expires: ${expiry}\n]\n`;
const applyRemovals = (entries: readonly DatedWaiver[], initial: string) => {
  let contents = initial;
  const read = () => contents;
  for (const waiver of entries) {
    contents = removeWaiver(waiver, read).at(0)?.after ?? contents;
  }
  return contents;
};
const group = () => {
  const result = radarProposalGroups(
    [entry("bunfig.toml"), entry(".claude/mcp/bunfig.toml")],
    now,
  ).at(0);
  if (!result) {
    throw new Error("Fixture group missing");
  }
  return result;
};
test("public proposal bodies show dates while structured proposals retain exact expiry", () => {
  const grouped = group();
  for (const kind of ["removal", "extension"] as const) {
    const body = radarBody(grouped, kind, now);
    expect(body).toContain("expiry 2026-10-18");
    expect(body).not.toMatch(/\b\d{2}:\d{2}\b/u);
    expect(body).not.toMatch(/T\d{2}[^\s]*Z/u);
    expect(body).not.toContain(expiry);
  }
  for (const proposalEntry of extensionProposal(grouped).entries) {
    expect(proposalEntry.expiresAt).toBe(expiry);
  }
});

test("three-day radar boundary includes exactly due entries", () => {
  expect(dueWaivers([entry("bunfig.toml")], now, 3)).toHaveLength(1);
  expect(
    dueWaivers([entry("bunfig.toml")], new Date(now.getTime() - 1), 3),
  ).toHaveLength(0);
});
test("one release-age proposal removes every carrying bunfig", () => {
  const grouped = group();
  expect(grouped.entries).toHaveLength(2);
  const result = radarFiles(grouped, () => fixture);
  expect(Object.keys(result.files).toSorted()).toEqual([
    ".claude/mcp/bunfig.toml",
    "bunfig.toml",
  ]);
  for (const content of Object.values(result.files)) {
    expect(content).not.toContain("bun-types");
  }
});

test("one release-age proposal removes all due exclusions from a shared bunfig", () => {
  const other = { ...entry("bunfig.toml"), id: "better-result", line: 4 };
  const grouped = radarProposalGroups([entry("bunfig.toml"), other], now);
  expect(grouped).toHaveLength(1);

  const fixtureBunfig = `[install]\nminimumReleaseAgeExcludes = [\n  "bun-types", # quarantine-expires: ${expiry}\n  "better-result", # quarantine-expires: ${expiry}\n]\n`;
  const bunfig = applyRemovals(grouped.at(0)?.entries ?? [], fixtureBunfig);
  expect(
    checkQuarantineExcludes({
      bunfig,
      lockfile: '"packages": {}',
      now: new Date(expiry),
    }).errors,
  ).toEqual([]);
});

test("release-age groups form connected components over packages and owning files", () => {
  const a1 = entry("bunfig1.toml");
  const a2 = entry("bunfig2.toml");
  const b = { ...entry("bunfig2.toml"), id: "better-result" };
  const c = { ...entry("bunfig3.toml"), id: "valibot" };
  const groups = radarProposalGroups([a1, c, b, a2], now);

  expect(groups).toHaveLength(2);
  expect(
    groups.map(({ entries }) => entries.map(({ id }) => id).toSorted()),
  ).toContainEqual(["better-result", "bun-types", "bun-types"]);
  expect(
    groups.map(({ entries }) => entries.map(({ id }) => id)),
  ).toContainEqual(["valibot"]);
});

test("release-age group keys are stable across input order", () => {
  const entries = [
    entry("bunfig1.toml"),
    entry("bunfig2.toml"),
    { ...entry("bunfig2.toml"), id: "better-result" },
  ];
  expect(radarProposalGroups(entries, now).at(0)?.key).toBe(
    radarProposalGroups(entries.toReversed(), now).at(0)?.key,
  );
});

test("release-age group identity survives owner order and subsets but separates deadlines", () => {
  const first = entry("bunfig.toml");
  const second = entry(".claude/mcp/bunfig.toml");
  const key = radarProposalGroups([first, second], now).at(0)?.key;
  expect(key).toBeDefined();
  for (const inventory of [[second, first], [first], [second]]) {
    expect(radarProposalGroups(inventory, now).at(0)?.key).toBe(key);
  }
  const anotherDeadline = {
    ...first,
    source: "another/bunfig.toml",
    expiresAt: "2026-10-17T12:00:00.000Z",
  };
  expect(radarProposalGroups([first, anotherDeadline], now)).toHaveLength(2);
  expect(radarProposalGroups([anotherDeadline], now).at(0)?.key).not.toBe(key);
});

test("orphan reconciliation retires only machine-owned removals absent from the proposal groups", async () => {
  const current = group();
  const proposal = (key: string) => ({
    key,
    branch: `chore/dated-waiver-${key}`,
  });
  const currentProposal = proposal(current.key);
  const staleRemoval = proposal("a".repeat(24));
  const ownerExtension = proposal("b".repeat(24));
  const otherProposal = proposal("c".repeat(24));
  const read: string[] = [];
  const orphans = await orphanRadarRemovals({
    inventory: current.entries,
    now,
    proposals: [currentProposal, staleRemoval, ownerExtension, otherProposal],
    readBody: async ({ key }) => {
      read.push(key);
      if (key === staleRemoval.key) {
        return "<!-- dated-exception-radar:1 -->\ndated-exception-action: removal";
      }
      if (key === ownerExtension.key) {
        return "<!-- dated-exception-radar:1 -->\ndated-exception-action: extension\nowner-reason: Accepted owner change";
      }
      return "Another maintenance proposal";
    },
  });
  expect(orphans).toEqual([staleRemoval]);
  expect(read).not.toContain(current.key);
  expect(radarWriteNeeded(0, orphans)).toBe(true);
  expect(radarWriteNeeded(0, [])).toBe(false);
  expect(radarWriteNeeded(0, [], true)).toBe(true);
});

test("orphan reconciliation and publication use the same due release-age groups", async () => {
  const expired = {
    ...entry("bunfig.toml"),
    expiresAt: "2026-10-14T12:00:00.000Z",
  };
  const later = {
    ...entry("bunfig.toml"),
    id: "better-result",
    expiresAt: "2026-10-17T12:00:00.000Z",
  };
  const inventory = [expired, later];
  const initialGroup = radarProposalGroups(inventory, now).at(0);
  if (!initialGroup) {
    throw new Error("Initial proposal group missing");
  }
  expect(initialGroup.entries).toEqual([expired]);
  const reversedGroup = radarProposalGroups(inventory.toReversed(), now).at(0);
  if (!reversedGroup) {
    throw new Error("Reversed proposal group missing");
  }
  expect(reversedGroup).toEqual(initialGroup);
  expect(radarAction(reversedGroup, "green", now)).toEqual(
    radarAction(initialGroup, "green", now),
  );

  const sharedBunfig = `[install]\nminimumReleaseAgeExcludes = [\n  "bun-types", # quarantine-expires: ${expired.expiresAt}\n  "better-result", # quarantine-expires: ${later.expiresAt}\n]\n`;
  const initialFiles = radarFiles(initialGroup, () => sharedBunfig).files;
  const initialBunfig = initialFiles["bunfig.toml"] ?? "";
  validateRadarRemoval({
    inventory,
    branch: `chore/dated-waiver-${initialGroup.key}`,
    files: initialFiles,
    read: () => sharedBunfig,
    now,
  });
  expect(
    prematureExclusionRemovals(
      { "bunfig.toml": sharedBunfig },
      { "bunfig.toml": initialBunfig },
      now,
    ),
  ).toEqual([]);
  expect(
    checkQuarantineExcludes({
      bunfig: initialBunfig,
      lockfile: '"packages": {}',
      now,
    }).errors,
  ).toEqual([]);
  const initialProposal = {
    key: initialGroup.key,
    branch: `chore/dated-waiver-${initialGroup.key}`,
  };
  const removalBody = async () =>
    "<!-- dated-exception-radar:1 -->\ndated-exception-action: removal";

  for (const runNow of [now, new Date("2026-10-15T18:00:00.000Z")]) {
    expect(
      await orphanRadarRemovals({
        inventory,
        now: runNow,
        proposals: [initialProposal],
        readBody: removalBody,
      }),
    ).toEqual([]);
    expect(radarProposalGroups(inventory, runNow)).toEqual([initialGroup]);
  }

  const expandedNow = new Date("2026-10-18T12:00:00.000Z");
  const expandedGroups = radarProposalGroups(inventory, expandedNow);
  expect(expandedGroups).toHaveLength(1);
  expect(expandedGroups.at(0)?.entries).toEqual([later, expired]);
  expect(radarProposalGroups(inventory.toReversed(), expandedNow)).toEqual(
    expandedGroups,
  );
  expect(expandedGroups.at(0)?.key).not.toBe(initialGroup.key);
  expect(
    await orphanRadarRemovals({
      inventory,
      now: expandedNow,
      proposals: [initialProposal],
      readBody: removalBody,
    }),
  ).toEqual([initialProposal]);
  const expandedGroup = expandedGroups.at(0);
  if (!expandedGroup) {
    throw new Error("Expanded proposal group missing");
  }
  const expandedFiles = radarFiles(expandedGroup, () => sharedBunfig).files;
  validateRadarRemoval({
    inventory,
    branch: `chore/dated-waiver-${expandedGroup.key}`,
    files: expandedFiles,
    read: () => sharedBunfig,
    now: expandedNow,
  });
  expect(
    prematureExclusionRemovals(
      { "bunfig.toml": sharedBunfig },
      { "bunfig.toml": expandedFiles["bunfig.toml"] ?? "" },
      expandedNow,
    ),
  ).toEqual([]);
});
test("release-age removal opens early and arms only at expiry", async () => {
  for (const [at, expected] of [
    [now, 0],
    [new Date(expiry), 1],
  ] as const) {
    const grouped = group();
    const published: string[] = [];
    const armed: number[] = [];
    await publishRadar({
      groups: [grouped],
      statuses: new Map([[grouped.key, "waiting"]]),
      now: at,
      publish: async (_, kind) => {
        published.push(kind);
        return { number: 1, headSha: "a".repeat(40) };
      },
      arm: async ({ number }) => {
        armed.push(number);
      },
    });
    expect(published).toEqual(["removal"]);
    expect(armed).toHaveLength(expected);
  }
});
test("unresolved proposals require owner input without changing dates", () => {
  const grouped = group();
  const first = grouped.entries.at(0);
  if (!first) {
    throw new Error("Fixture entry missing");
  }
  const ordinary = {
    ...grouped,
    entries: [{ ...first, kind: "dependency-audit" as const }],
  };
  expect(radarAction(ordinary, "red", now)).toEqual({
    kind: "extension",
    arm: false,
  });
  expect(radarAction(ordinary, "green", now)).toEqual({
    kind: "removal",
    arm: true,
  });
  expect(extensionProposal(ordinary).ownerReason).toBe(OWNER_REASON_REQUIRED);
  expect(extensionProposal(ordinary).entries.at(0)?.expiresAt).toBe(expiry);
});
test("arming requires the complete generated edit after expiry", () => {
  const grouped = group();
  const files = radarFiles(grouped, () => fixture).files;
  const input = {
    inventory: grouped.entries,
    branch: `chore/dated-waiver-${grouped.key}`,
    files,
    read: () => fixture,
    now: new Date(expiry),
  };
  validateRadarRemoval(input);
  expect(() => validateRadarRemoval({ ...input, now })).toThrow(
    "before expiry",
  );
  expect(() =>
    validateRadarRemoval({
      ...input,
      files: { "bunfig.toml": files["bunfig.toml"] ?? "" },
    }),
  ).toThrow("complete owner-derived edit");
  expect(() =>
    validateRadarRemoval({
      ...input,
      files: { ...files, "package.json": "{}" },
    }),
  ).toThrow("complete owner-derived edit");
});
test("clean inventory performs no writes or arming", async () => {
  let writes = 0;
  await publishRadar({
    groups: radarProposalGroups([], now),
    statuses: new Map(),
    now,
    publish: async () => {
      writes++;
      return undefined;
    },
    arm: async () => {
      writes++;
    },
  });
  expect(writes).toBe(0);
});

test("unchanged removal reuses the proposal until its eligibility changes", async () => {
  const grouped = group();
  const files = radarFiles(grouped, () => fixture).files;
  const body = radarBody(grouped, "removal", now);
  const sha = "a".repeat(40);
  const request = async (args: readonly string[]): Promise<unknown> => {
    const endpoint = args.at(0) ?? "";
    if (endpoint.includes("pulls?")) {
      return [{ number: 8, body, head: { sha }, base: { sha } }];
    }
    if (endpoint.includes("/files?")) {
      return Object.keys(files).map((filename) => ({
        filename,
        status: "modified",
      }));
    }
    const name = Object.keys(files).find((file) =>
      endpoint.includes(`/contents/${file}?`),
    );
    if (!name) {
      throw new Error("Unexpected fixture endpoint");
    }
    return {
      content: Buffer.from(files[name] ?? "").toString("base64"),
      encoding: "base64",
    };
  };
  const input = {
    key: grouped.key,
    kind: "removal" as const,
    body,
    baseSha: sha,
    files,
    request,
  };
  expect(await existingRadarProposal(input)).toEqual({
    state: "current",
    proposal: { number: 8, headSha: sha },
  });
  expect(
    await existingRadarProposal({
      ...input,
      body: radarBody(grouped, "removal", new Date(expiry)),
    }),
  ).toBeUndefined();
  expect(
    await existingRadarProposal({ ...input, baseSha: "b".repeat(40) }),
  ).toBeUndefined();
});

test("extension refresh preserves owner changes", async () => {
  const grouped = group();
  const existing = await existingRadarProposal({
    key: grouped.key,
    kind: "extension",
    body: "placeholder",
    baseSha: "a".repeat(40),
    files: {},
    request: async () => [
      {
        number: 9,
        body: "<!-- dated-exception-radar:1 -->\ndated-exception-action: extension\nowner-reason: Concrete owner decision",
        head: { sha: "b".repeat(40) },
        base: { sha: "c".repeat(40) },
      },
    ],
  });
  expect(existing).toEqual({
    state: "owner",
    proposal: { number: 9, headSha: "b".repeat(40) },
  });
});

test("a green probe never replaces an owner-edited extension request", async () => {
  const grouped = group();
  const first = grouped.entries.at(0);
  if (!first) {
    throw new Error("Fixture entry missing");
  }
  const ordinary = {
    ...grouped,
    entries: [{ ...first, kind: "dependency-audit" as const }],
  };
  expect(radarAction(ordinary, "red", now).kind).toBe("extension");
  const ownerBody = radarBody(ordinary, "extension", now).replace(
    `owner-reason: ${OWNER_REASON_REQUIRED}`,
    "owner-reason: Concrete owner decision",
  );
  const requested: string[] = [];
  const request = async (args: readonly string[]) => {
    requested.push(args.join(" "));
    return [
      {
        number: 11,
        body: ownerBody,
        head: { sha: "d".repeat(40) },
        base: { sha: "c".repeat(40) },
      },
    ];
  };
  const green = radarAction(ordinary, "green", now);
  expect(green).toEqual({ kind: "removal", arm: true });
  const existing = await existingRadarProposal({
    key: ordinary.key,
    kind: green.kind,
    body: radarBody(ordinary, green.kind, now),
    baseSha: "a".repeat(40),
    files: { "bunfig.toml": "removed" },
    request,
  });
  expect(existing).toEqual({
    state: "owner",
    proposal: { number: 11, headSha: "d".repeat(40) },
  });
  expect(requested).toHaveLength(1);
  const armed: number[] = [];
  await publishRadar({
    groups: [ordinary],
    statuses: new Map([[ordinary.key, "green"]]),
    now,
    publish: async (_group, kind) => {
      const reuse = radarReuse(existing, kind);
      if (reuse.publish) {
        throw new Error("Owner request must not be republished");
      }
      return reuse.proposal;
    },
    arm: async ({ number }) => {
      armed.push(number);
    },
  });
  expect(armed).toEqual([]);
});

test("failed probes replace an existing removal with an owner extension request", async () => {
  const grouped = group();
  const first = grouped.entries.at(0);
  if (!first) {
    throw new Error("Fixture entry missing");
  }
  const ordinary = {
    ...grouped,
    entries: [{ ...first, kind: "dependency-audit" as const }],
  };
  const action = radarAction(ordinary, "red", now);
  expect(action).toEqual({ kind: "extension", arm: false });
  const reusable = await existingRadarProposal({
    key: ordinary.key,
    kind: action.kind,
    body: radarBody(ordinary, action.kind, now),
    baseSha: "a".repeat(40),
    files: {},
    request: async () => [
      {
        number: 9,
        body: radarBody(ordinary, "removal", now),
        head: { sha: "b".repeat(40) },
        base: { sha: "a".repeat(40) },
      },
    ],
  });
  expect(reusable).toBeUndefined();
});

test("one failed publication does not suppress another due proposal", async () => {
  const first = group();
  const second = { ...first, key: "another-key" };
  const attempted: string[] = [];
  expect(
    await rejectionOf(
      publishRadar({
        groups: [first, second],
        statuses: new Map([
          [first.key, "waiting"],
          [second.key, "waiting"],
        ]),
        now,
        publish: async ({ key }) => {
          attempted.push(key);
          if (key === first.key) {
            throw new TypeError("Fixture publication failure");
          }
          return undefined;
        },
        arm: async () => {},
      }),
    ),
  ).toMatchObject({ keys: [first.key] });
  expect(attempted).toEqual([first.key, second.key]);
});
