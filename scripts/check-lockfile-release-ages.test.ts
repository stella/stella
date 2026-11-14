import { describe, expect, test } from "bun:test";

import {
  checkLockfileReleaseAges,
  createRegistryLookup,
  governingBunfigPath,
  type LockfileInput,
  readLockfilePins,
} from "./check-lockfile-release-ages";
import {
  CRATES_IO_SOURCE,
  createCratesIoClient,
  readCargoLockPins,
} from "./crates-io-release-age";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** For bun.lock-only cases: a crates.io lookup is never expected. */
const noCratesIo = async () => {
  throw new Error("unexpected crates.io lookup");
};
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
) =>
  checkLockfileReleaseAges({
    lockfiles,
    lookups: { cratesIo: noCratesIo, npm: lookup },
    now: NOW,
  });

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

  test("gates a new pin again once its temporary exclude has expired", async () => {
    // Bun matches the name and ignores the comment, so an elapsed entry would
    // still let a fresh version in; the waiver grants nothing once it lapses.
    const registry = fakeRegistry({
      "lapsed-excluded": {
        "1.0.0": daysBefore(1),
        "0.9.0": "2026-01-01T00:00:00.000Z",
      },
    });
    const young = await check(
      [
        rootLockfile(
          {},
          { "lapsed-excluded": npm("lapsed-excluded", "1.0.0") },
        ),
      ],
      registry.lookup,
    );
    const old = await check(
      [
        rootLockfile(
          {},
          { "lapsed-excluded": npm("lapsed-excluded", "0.9.0") },
        ),
      ],
      registry.lookup,
    );

    expect(Date.parse("2026-09-27T00:00:00.000Z")).toBeLessThan(NOW.getTime());
    expect(registry.requested).toEqual(["lapsed-excluded"]);
    expect(young.quarantined).toEqual([
      expect.stringContaining("bun.lock: lapsed-excluded@1.0.0 was published"),
    ]);
    expect(old.quarantined).toEqual([]);
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
    // Install-free: this test runs before the dependency install.
    const twoStarted = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const lookup = createRegistryLookup({
      concurrency: 2,
      fetch: async (url) => {
        requested.push(url);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        if (inFlight === 2) {
          twoStarted.resolve(undefined);
        }
        await release.promise;
        inFlight -= 1;
        return Response.json({
          time: { "1.0.0": daysBefore(9), "2.0.0": daysBefore(8) },
        });
      },
    });

    const names = ["@scope/a", "b", "c", "d", "e"];
    const lookups = Promise.all(
      names.flatMap((name) => [
        lookup({ name, version: "1.0.0" }),
        lookup({ name, version: "2.0.0" }),
      ]),
    );
    await twoStarted.promise;
    expect(peak).toBe(2);
    release.resolve(undefined);
    await lookups;

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
    lookups: { cratesIo: noCratesIo, npm: registry.lookup },
    now: NOW,
    packageName: "young-excluded",
  });
  expect(report.quarantined).toHaveLength(1);
  expect(registry.requested).toEqual(["young-excluded"]);
  const missing = await checkLockfileReleaseAges({
    lockfiles: [removed],
    lookups: { cratesIo: noCratesIo, npm: registry.lookup },
    now: NOW,
    packageName: "absent",
  });
  expect(missing.errors).toContain(
    "No registry pins found for requested package: absent",
  );
});

type CrateFixture = { name: string; source?: string; version: string };

/** A Cargo.lock in Cargo's own shape. */
const cargoLock = (packages: readonly CrateFixture[]) =>
  [
    "# This file is automatically @generated by Cargo.",
    "# It is not intended for manual editing.",
    "version = 4",
    ...packages.flatMap(({ name, source, version }) => [
      "",
      "[[package]]",
      `name = "${name}"`,
      `version = "${version}"`,
      ...(source === undefined ? [] : [`source = "${source}"`]),
    ]),
    "",
  ].join("\n");

const crate = (name: string, version: string): CrateFixture => ({
  name,
  source: CRATES_IO_SOURCE,
  version,
});

const CRATE_BUNFIG = `[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
  "young-excluded", # quarantine-expires: 2026-09-30T00:00:00.000Z
  "cargo:young-crate", # quarantine-expires: 2026-09-30T00:00:00.000Z
  "cargo:lapsed-crate", # quarantine-expires: 2026-09-27T00:00:00.000Z
]
`;

/** crates.io, answering per-version reads from fixture publish times. */
const fakeCratesIo = (
  times: PublishTimes,
  respond?: (url: string) => Response | undefined,
) => {
  const requested: string[] = [];
  const userAgents: (string | null)[] = [];
  const client = createCratesIoClient({
    fetch: async (url, init) => {
      requested.push(url);
      userAgents.push(new Headers(init.headers).get("user-agent"));
      const override = respond?.(url);
      if (override !== undefined) {
        return override;
      }
      const [name = "", version = ""] = url
        .slice("https://crates.io/api/v1/crates/".length)
        .split("/")
        .map(decodeURIComponent);
      const createdAt = times[name]?.[version];
      return createdAt === undefined
        ? new Response("not found", { status: 404 })
        : Response.json({
            version: {
              crate: name,
              created_at: createdAt,
              num: version,
              yanked: false,
            },
          });
    },
    intervalMs: 0,
    retryDelayMs: 0,
  });
  return { lookup: client.publishTime, requested, userAgents };
};

const cargoLockfile = (
  base: readonly CrateFixture[] | undefined,
  head: readonly CrateFixture[],
  lockPath = "packages/scan-engine/Cargo.lock",
): LockfileInput => ({
  baseText: base === undefined ? undefined : cargoLock(base),
  bunfigText: CRATE_BUNFIG,
  headText: cargoLock(head),
  path: lockPath,
});

const checkCargo = async (
  lockfiles: readonly LockfileInput[],
  cratesIo: ReturnType<typeof fakeCratesIo>,
  packageName?: string,
) =>
  checkLockfileReleaseAges({
    lockfiles,
    lookups: {
      cratesIo: cratesIo.lookup,
      npm: async () => {
        throw new Error("unexpected npm lookup");
      },
    },
    now: NOW,
    ...(packageName === undefined ? {} : { packageName }),
  });

describe("new Cargo.lock pins against the release-age quarantine", () => {
  test("holds every Cargo.lock to the root bunfig.toml", () => {
    expect(governingBunfigPath("packages/scan-engine/Cargo.lock")).toBe(
      "bunfig.toml",
    );
    expect(governingBunfigPath("apps/desktop/src-tauri/Cargo.lock")).toBe(
      "bunfig.toml",
    );
  });

  test("fails a crate published inside the quarantine and names a cargo: exclude", async () => {
    const cratesIo = fakeCratesIo({
      image: { "0.25.11": "2026-09-26T08:00:00.000Z" },
    });
    const report = await checkCargo(
      [cargoLockfile([crate("image", "0.25.10")], [crate("image", "0.25.11")])],
      cratesIo,
    );

    expect(report.quarantined).toHaveLength(1);
    const [message] = report.quarantined;
    expect(message).toContain(
      "packages/scan-engine/Cargo.lock: image@0.25.11 was published 2026-09-26T08:00:00.000Z",
    );
    expect(message).toContain(
      "the 5-day quarantine of bunfig.toml admits it at 2026-10-01T08:00:00.000Z",
    );
    expect(message).toContain(
      '"cargo:image", # quarantine-expires: 2026-10-01T08:00:00.000Z',
    );
    expect(cratesIo.requested).toEqual([
      "https://crates.io/api/v1/crates/image/0.25.11",
    ]);
    expect(cratesIo.userAgents).toEqual([
      expect.stringContaining("stella-lockfile-release-age-check"),
    ]);
    expect(report.errors).toEqual([]);
  });

  test("passes an aged crate and never looks up a pin the merge base had", async () => {
    const cratesIo = fakeCratesIo({
      autocfg: { "1.5.1": daysBefore(1) },
      image: { "0.25.11": daysBefore(5) },
    });
    const report = await checkCargo(
      [
        cargoLockfile(
          [crate("autocfg", "1.5.1"), crate("image", "0.25.10")],
          [
            crate("autocfg", "1.5.1"),
            crate("image", "0.25.11"),
            { name: "stella-scan-engine", version: "0.0.1" },
          ],
        ),
      ],
      cratesIo,
    );

    expect(cratesIo.requested).toEqual([
      "https://crates.io/api/v1/crates/image/0.25.11",
    ]);
    expect(report.quarantined).toEqual([]);
    expect(report.checked).toEqual([
      `packages/scan-engine/Cargo.lock: image@0.25.11 published ${daysBefore(5)}, cleared the 5-day quarantine of bunfig.toml`,
    ]);
  });

  test("a cargo: exclude exempts the crate until it expires, and an npm exclude never does", async () => {
    const cratesIo = fakeCratesIo({
      "lapsed-crate": { "1.0.0": daysBefore(1) },
      "young-excluded": { "1.0.0": daysBefore(1) },
    });
    const report = await checkCargo(
      [
        cargoLockfile(
          [],
          [
            crate("lapsed-crate", "1.0.0"),
            crate("young-crate", "1.0.0"),
            crate("young-excluded", "1.0.0"),
          ],
        ),
      ],
      cratesIo,
    );

    expect(report.checked).toEqual([
      "packages/scan-engine/Cargo.lock: young-crate@1.0.0 excluded from the quarantine by bunfig.toml (temporary, recorded admission 2026-09-30T00:00:00.000Z)",
    ]);
    expect(report.quarantined).toEqual([
      expect.stringContaining("lapsed-crate@1.0.0 was published"),
      expect.stringContaining("young-excluded@1.0.0 was published"),
    ]);
    expect(cratesIo.requested.toSorted()).toEqual([
      "https://crates.io/api/v1/crates/lapsed-crate/1.0.0",
      "https://crates.io/api/v1/crates/young-excluded/1.0.0",
    ]);
  });

  test("fails closed when crates.io cannot answer, retrying only transient failures", async () => {
    const outage = fakeCratesIo({}, (url) =>
      url.includes("/flaky/")
        ? new Response("unavailable", { status: 503 })
        : undefined,
    );
    const report = await checkCargo(
      [
        cargoLockfile(undefined, [
          crate("flaky", "1.0.0"),
          crate("missing", "1.0.0"),
        ]),
      ],
      outage,
    );

    expect(outage.requested.toSorted()).toEqual([
      "https://crates.io/api/v1/crates/flaky/1.0.0",
      "https://crates.io/api/v1/crates/flaky/1.0.0",
      "https://crates.io/api/v1/crates/flaky/1.0.0",
      "https://crates.io/api/v1/crates/missing/1.0.0",
    ]);
    expect(report.unverified).toEqual([
      "packages/scan-engine/Cargo.lock: flaky@1.0.0: crates.io answered HTTP 503",
      "packages/scan-engine/Cargo.lock: missing@1.0.0: crates.io answered HTTP 404",
    ]);
    expect(report.checked).toEqual([]);
  });

  test("a waiver probe selects crates by their cargo: exclude name", async () => {
    const cratesIo = fakeCratesIo({
      "young-crate": { "1.0.0": daysBefore(1) },
      "young-excluded": { "1.0.0": daysBefore(1) },
    });
    const lockfile = {
      ...cargoLockfile(undefined, [
        crate("young-crate", "1.0.0"),
        crate("young-excluded", "1.0.0"),
      ]),
      bunfigText: "[install]\nminimumReleaseAge = 432_000\n",
    };
    const probe = await checkCargo([lockfile], cratesIo, "cargo:young-crate");

    expect(probe.quarantined).toEqual([
      expect.stringContaining("young-crate@1.0.0 was published"),
    ]);
    expect(cratesIo.requested).toEqual([
      "https://crates.io/api/v1/crates/young-crate/1.0.0",
    ]);
    const npmName = await checkCargo([lockfile], cratesIo, "young-crate");
    expect(npmName.errors).toContain(
      "No registry pins found for requested package: young-crate",
    );
  });
});

describe("reading Cargo.lock pins", () => {
  test("keeps crates.io pins, skips local packages, and reports git sources", () => {
    const pins = readCargoLockPins(
      cargoLock([
        crate("image", "0.25.10"),
        crate("image", "0.25.10"),
        crate("wasm-bindgen", "0.2.126"),
        { name: "stella-scan-engine", version: "0.0.1" },
        {
          name: "from-git",
          source: "git+https://github.com/owner/repo?rev=abc#abc123",
          version: "0.1.0",
        },
      ]),
      "Cargo.lock",
    );

    expect(pins.pins).toEqual([
      { name: "image", version: "0.25.10" },
      { name: "wasm-bindgen", version: "0.2.126" },
    ]);
    expect(pins.external).toEqual([
      "from-git@0.1.0 (git+https://github.com/owner/repo?rev=abc#abc123)",
    ]);
    expect(pins.errors).toEqual([]);
  });

  test("rejects a registry it cannot verify and a lock it cannot read", () => {
    const pins = readCargoLockPins(
      cargoLock([
        {
          name: "mirrored",
          source: "sparse+https://mirror.example.test/index/",
          version: "1.0.0",
        },
      ]),
      "Cargo.lock",
    );

    expect(pins.pins).toEqual([]);
    expect(pins.errors).toEqual([
      "Cargo.lock package mirrored@1.0.0 resolves from a source this check cannot verify: sparse+https://mirror.example.test/index/",
    ]);
    expect(readCargoLockPins("[[package]\n", "Cargo.lock").errors).toEqual([
      expect.stringContaining("Cargo.lock does not parse"),
    ]);
  });

  test("reads both tracked Cargo.lock files without errors", async () => {
    for (const lockPath of [
      "packages/scan-engine/Cargo.lock",
      "apps/desktop/src-tauri/Cargo.lock",
    ]) {
      const text = await Bun.file(
        new URL(`../${lockPath}`, import.meta.url),
      ).text();
      const pins = readCargoLockPins(text, lockPath);
      expect(pins.errors, lockPath).toEqual([]);
      expect(pins.pins.length, lockPath).toBeGreaterThan(0);
    }
  });
});
