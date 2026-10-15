import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  existingRadarProposal,
  extensionProposal,
  OWNER_REASON_REQUIRED,
  orphanRadarRemovals,
  publishRadar,
  radarAction,
  radarBody,
  radarFiles,
  radarGroups,
  radarWriteNeeded,
  validateRadarRemoval,
} from "./dated-exception-radar";
import { dueWaivers, type DatedWaiver } from "./dated-waivers";

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
const group = () => {
  const result = radarGroups([
    entry("bunfig.toml"),
    entry(".claude/mcp/bunfig.toml"),
  ]).at(0);
  if (!result) {
    throw new Error("Fixture group missing");
  }
  return result;
};
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

test("release-age group identity survives owner order and subsets but separates deadlines", () => {
  const first = entry("bunfig.toml");
  const second = entry(".claude/mcp/bunfig.toml");
  const key = radarGroups([first, second]).at(0)?.key;
  expect(key).toBeDefined();
  for (const inventory of [[second, first], [first], [second]]) {
    expect(radarGroups(inventory).at(0)?.key).toBe(key);
  }
  const anotherDeadline = { ...first, expiresAt: "2026-10-19T12:00:00.000Z" };
  expect(radarGroups([first, anotherDeadline])).toHaveLength(2);
  expect(radarGroups([anotherDeadline]).at(0)?.key).not.toBe(key);
});

test("orphan reconciliation retires only radar removals absent from the full inventory", async () => {
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
    groups: radarGroups([]),
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
    number: 8,
    headSha: sha,
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
  expect(existing).toEqual({ number: 9, headSha: "b".repeat(40) });
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
