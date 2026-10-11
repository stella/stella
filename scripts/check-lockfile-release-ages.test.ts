import { describe, expect, test } from "bun:test";

import {
  checkLockfileReleaseAges,
  createRegistryLookup,
  governingBunfigPath,
  readLockfilePins,
  type LockfileInput,
} from "./check-lockfile-release-ages";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysBefore = (days: number) =>
  new Date(NOW.getTime() - days * DAY_MS).toISOString();

/** A bun.lock in Bun's own shape, trailing commas included. */
const lock = (entries: Readonly<Record<string, readonly unknown[]>>) =>
  [
    "{",
    '  "lockfileVersion": 1,',
    '  "workspaces": {',
    '    "": { "name": "fixture", },',
    "  },",
    '  "packages": {',
    ...Object.entries(entries).map(
      ([key, entry]) => `    "${key}": ${JSON.stringify(entry)},`,
    ),
    "  },",
    "}",
    "",
  ].join("\n");

const npm = (name: string, version: string) => [
  `${name}@${version}`,
  "",
  {},
  "sha512-fixture",
];

const ROOT_BUNFIG = `[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
  # Fixture reason for a temporary exception.
  "young-excluded", # quarantine-expires: 2026-09-30T00:00:00.000Z
  "lapsed-excluded", # quarantine-expires: 2026-09-27T00:00:00.000Z
  "@stll/native", # quarantine-excluded-since: 2026-07-08T00:22:40.000Z
]
`;

type PublishTimes = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** The registry, answering full packuments from fixture publish times. */
const fakeRegistry = (
  times: PublishTimes,
  respond?: (name: string) => Response | undefined,
) => {
  const requested: string[] = [];
  const fetch = async (url: string) => {
    const name = decodeURIComponent(
      url.slice("https://registry.npmjs.org/".length),
    );
    requested.push(name);
    const override = respond?.(name);
    if (override !== undefined) {
      return override;
    }
    const time = times[name];
    return time === undefined
      ? new Response("not found", { status: 404 })
      : Response.json({ name, time: { created: "2020-01-01", ...time } });
  };
  return {
    lookup: createRegistryLookup({ fetch, retryDelayMs: 0 }),
    requested,
  };
};

const check = async (
  lockfiles: readonly LockfileInput[],
  lookup: ReturnType<typeof fakeRegistry>["lookup"],
) => checkLockfileReleaseAges({ lockfiles, lookup, now: NOW });

const rootLockfile = (
  base: Readonly<Record<string, readonly unknown[]>>,
  head: Readonly<Record<string, readonly unknown[]>>,
): LockfileInput => ({
  baseText: lock(base),
  bunfigText: ROOT_BUNFIG,
  headText: lock(head),
  path: "bun.lock",
});

describe("new lockfile pins against the release-age quarantine", () => {
  test("fails a pin published inside the quarantine, naming both ways forward", async () => {
    const registry = fakeRegistry({
      "left-pad": { "1.3.0": "2026-09-26T08:00:00.000Z" },
    });
    const report = await check(
      [
        rootLockfile(
          { "left-pad": npm("left-pad", "1.2.0") },
          { "left-pad": npm("left-pad", "1.3.0") },
        ),
      ],
      registry.lookup,
    );

    expect(report.quarantined).toHaveLength(1);
    const [message] = report.quarantined;
    expect(message).toContain("bun.lock: left-pad@1.3.0");
    expect(message).toContain("published 2026-09-26T08:00:00.000Z");
    expect(message).toContain("admits it at 2026-10-01T08:00:00.000Z");
    expect(message).toContain(
      '"left-pad", # quarantine-expires: 2026-10-01T08:00:00.000Z',
    );
    expect(report.errors).toEqual([]);
    expect(report.unverified).toEqual([]);
  });

  test("passes a pin published before the quarantine began", async () => {
    const registry = fakeRegistry({ "left-pad": { "1.3.0": daysBefore(6) } });
    const report = await check(
      [rootLockfile({}, { "left-pad": npm("left-pad", "1.3.0") })],
      registry.lookup,
    );

    expect(report.quarantined).toEqual([]);
    expect(report.checked).toEqual([
      expect.stringContaining("left-pad@1.3.0 published"),
    ]);
  });

  test("admits a pin exactly when the quarantine ends, as Bun does", async () => {
    const edge = fakeRegistry({ edge: { "1.0.0": daysBefore(5) } });
    const justInside = fakeRegistry({
      edge: { "1.0.0": new Date(NOW.getTime() - 5 * DAY_MS + 1).toISOString() },
    });
    const lockfiles = [rootLockfile({}, { edge: npm("edge", "1.0.0") })];

    expect((await check(lockfiles, edge.lookup)).quarantined).toEqual([]);
    expect(
      (await check(lockfiles, justInside.lookup)).quarantined,
    ).toHaveLength(1);
  });

  test("passes excluded packages without asking the registry, temporary or permanent", async () => {
    const registry = fakeRegistry({});
    const report = await check(
      [
        rootLockfile(
          {},
          {
            "@stll/native": npm("@stll/native", "2.0.0"),
            "young-excluded": npm("young-excluded", "1.0.0"),
          },
        ),
      ],
      registry.lookup,
    );

    expect(registry.requested).toEqual([]);
    expect(report.quarantined).toEqual([]);
    expect(report.unverified).toEqual([]);
    expect(report.checked).toContainEqual(
      expect.stringContaining(
        "young-excluded@1.0.0 excluded from the quarantine by bunfig.toml (temporary, recorded admission 2026-09-30T00:00:00.000Z)",
      ),
    );
  });

  test("still honours a temporary exclude whose admission instant has passed", async () => {
    // Bun matches the name and ignores the comment; retiring the entry is the
    // quarantine-exclude guard's job, not this check's.
    const registry = fakeRegistry({
      "lapsed-excluded": { "1.0.0": daysBefore(1) },
    });
    const report = await check(
      [
        rootLockfile(
          {},
          { "lapsed-excluded": npm("lapsed-excluded", "1.0.0") },
        ),
      ],
      registry.lookup,
    );

    expect(Date.parse("2026-09-27T00:00:00.000Z")).toBeLessThan(NOW.getTime());
    expect(report.quarantined).toEqual([]);
    expect(registry.requested).toEqual([]);
  });

  test("never looks up a pin the merge base already had", async () => {
    const registry = fakeRegistry({
      changed: { "2.0.0": daysBefore(10) },
      unchanged: { "1.0.0": daysBefore(1) },
    });
    const report = await check(
      [
        rootLockfile(
          {
            changed: npm("changed", "1.0.0"),
            unchanged: npm("unchanged", "1.0.0"),
          },
          {
            changed: npm("changed", "2.0.0"),
            // The same pin under another key is not new either.
            "parent/unchanged": npm("unchanged", "1.0.0"),
            unchanged: npm("unchanged", "1.0.0"),
          },
        ),
      ],
      registry.lookup,
    );

    expect(registry.requested).toEqual(["changed"]);
    expect(report.quarantined).toEqual([]);
  });

  test("fails closed when the registry cannot answer, after retrying", async () => {
    const outage = fakeRegistry(
      {},
      () => new Response("unavailable", { status: 503 }),
    );
    const report = await check(
      [rootLockfile({}, { "left-pad": npm("left-pad", "1.3.0") })],
      outage.lookup,
    );

    expect(outage.requested).toEqual(["left-pad", "left-pad", "left-pad"]);
    expect(report.unverified).toEqual([
      "bun.lock: left-pad@1.3.0: registry answered HTTP 503",
    ]);
    expect(report.checked).toEqual([]);
  });

  test("fails closed on a network error and on a version the registry does not list", async () => {
    const lookup = createRegistryLookup({
      fetch: async (url) => {
        if (url.endsWith("/offline")) {
          throw new TypeError("fetch failed");
        }
        return Response.json({ time: { "0.1.0": daysBefore(30) } });
      },
      retryDelayMs: 0,
    });
    const report = await check(
      [
        rootLockfile(
          {},
          {
            offline: npm("offline", "1.0.0"),
            unlisted: npm("unlisted", "1.0.0"),
          },
        ),
      ],
      lookup,
    );

    expect(report.unverified).toEqual([
      "bun.lock: offline@1.0.0: request failed: TypeError: fetch failed",
      "bun.lock: unlisted@1.0.0: the registry lists no publish time for 1.0.0",
    ]);
  });

  test("does not retry a package the registry does not have", async () => {
    const registry = fakeRegistry({});
    const report = await check(
      [rootLockfile({}, { missing: npm("missing", "1.0.0") })],
      registry.lookup,
    );

    expect(registry.requested).toEqual(["missing"]);
    expect(report.unverified).toEqual([
      "bun.lock: missing@1.0.0: registry answered HTTP 404",
    ]);
  });

  test("a standalone lockfile follows its own bunfig, not the root's", async () => {
    expect(governingBunfigPath(".claude/mcp/bun.lock")).toBe(
      ".claude/mcp/bunfig.toml",
    );
    expect(governingBunfigPath("bun.lock")).toBe("bunfig.toml");
    const registry = fakeRegistry({
      "young-excluded": { "1.0.0": daysBefore(2) },
      zod: { "4.6.5": daysBefore(2) },
    });
    const standalone: LockfileInput = {
      baseText: undefined,
      bunfigText: "[install]\nminimumReleaseAge = 86_400\n",
      headText: lock({
        "young-excluded": npm("young-excluded", "1.0.0"),
        zod: npm("zod", "4.6.5"),
      }),
      path: ".claude/mcp/bun.lock",
    };
    const report = await check(
      [standalone, rootLockfile({}, { zod: npm("zod", "4.6.5") })],
      registry.lookup,
    );

    // A two-day-old zod clears the standalone one-day quarantine but not the
    // root five-day one, and the root's excludes do not reach the standalone
    // lockfile.
    expect(report.checked).toContainEqual(
      expect.stringContaining(
        `.claude/mcp/bun.lock: zod@4.6.5 published ${daysBefore(2)}, cleared the 1-day quarantine of .claude/mcp/bunfig.toml`,
      ),
    );
    expect(report.checked).toContainEqual(
      expect.stringContaining(
        ".claude/mcp/bun.lock: young-excluded@1.0.0 published",
      ),
    );
    expect(report.quarantined).toEqual([
      expect.stringContaining(
        `bun.lock: zod@4.6.5 was published ${daysBefore(2)}; the 5-day quarantine of bunfig.toml`,
      ),
    ]);
    // One packument serves both lockfiles.
    expect(registry.requested.toSorted()).toEqual(["young-excluded", "zod"]);
  });

  test("fails a changed lockfile that no quarantine governs", async () => {
    const registry = fakeRegistry({ zod: { "4.6.5": daysBefore(30) } });
    const report = await check(
      [
        {
          baseText: undefined,
          bunfigText: undefined,
          headText: lock({ zod: npm("zod", "4.6.5") }),
          path: "tools/bun.lock",
        },
      ],
      registry.lookup,
    );

    expect(report.errors).toEqual([
      expect.stringContaining(
        "tools/bun.lock adds 1 pin(s) but no release-age quarantine governs it",
      ),
    ]);
    expect(registry.requested).toEqual([]);
  });
});

describe("reading lockfile pins", () => {
  test("keeps registry pins, skips local entries, and reports other sources", () => {
    const pins = readLockfilePins(
      lock({
        "@scope/pkg": npm("@scope/pkg", "1.0.0-beta.1"),
        "from-git": [
          "from-git@git+ssh://git@github.com/owner/repo.git#abc123",
          {},
          "abc123",
        ],
        "from-tarball": ["from-tarball@https://example.test/t.tgz", {}],
        local: ["local@workspace:packages/local"],
        linked: ["linked@link:../linked"],
      }),
      "bun.lock",
    );

    expect(pins.pins).toEqual([
      { name: "@scope/pkg", version: "1.0.0-beta.1" },
    ]);
    expect(pins.external).toEqual([
      "from-git@git+ssh://git@github.com/owner/repo.git#abc123",
      "from-tarball@https://example.test/t.tgz",
    ]);
    expect(pins.errors).toEqual([]);
  });

  test("rejects entries it cannot verify rather than skipping them", () => {
    const pins = readLockfilePins(
      lock({
        mirrored: ["mirrored@1.0.0", "https://mirror.example.test/", {}, "x"],
        odd: ["odd@latest", "", {}, "x"],
      }),
      "bun.lock",
    );

    expect(pins.pins).toEqual([]);
    expect(pins.errors).toEqual([
      'bun.lock package "mirrored" (mirrored@1.0.0) resolves from a registry this check cannot verify: https://mirror.example.test/',
      'bun.lock package "odd" has an unrecognized specifier: odd@latest',
    ]);
  });
});

describe("registry lookup", () => {
  test("fetches one packument per package, scoped names escaped, within the concurrency bound", async () => {
    const requested: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const lookup = createRegistryLookup({
      concurrency: 2,
      fetch: async (url) => {
        requested.push(url);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
        return Response.json({
          time: { "1.0.0": daysBefore(9), "2.0.0": daysBefore(8) },
        });
      },
    });

    const names = ["@scope/a", "b", "c", "d", "e"];
    await Promise.all(
      names.flatMap((name) => [
        lookup({ name, version: "1.0.0" }),
        lookup({ name, version: "2.0.0" }),
      ]),
    );

    expect(requested.toSorted()).toEqual([
      "https://registry.npmjs.org/@scope%2Fa",
      "https://registry.npmjs.org/b",
      "https://registry.npmjs.org/c",
      "https://registry.npmjs.org/d",
      "https://registry.npmjs.org/e",
    ]);
    expect(peak).toBe(2);
  });
});

test("a waiver probe checks unchanged selected pins and fails an absent package", async () => {
  const registry = fakeRegistry({
    "young-excluded": { "1.0.0": daysBefore(1) },
  });
  const lockfile = rootLockfile(
    {},
    { "young-excluded": npm("young-excluded", "1.0.0") },
  );
  const removed = {
    ...lockfile,
    baseText: undefined,
    bunfigText: ROOT_BUNFIG.replace(
      '  "young-excluded", # quarantine-expires: 2026-09-30T00:00:00.000Z\n',
      "",
    ),
  };
  const report = await checkLockfileReleaseAges({
    lockfiles: [removed],
    lookup: registry.lookup,
    now: NOW,
    packageName: "young-excluded",
  });
  expect(report.quarantined).toHaveLength(1);
  expect(registry.requested).toEqual(["young-excluded"]);
  const missing = await checkLockfileReleaseAges({
    lockfiles: [removed],
    lookup: registry.lookup,
    now: NOW,
    packageName: "absent",
  });
  expect(missing.errors).toContain(
    "No registry pins found for requested package: absent",
  );
});
