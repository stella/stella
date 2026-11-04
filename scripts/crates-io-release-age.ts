/**
 * crates.io pins in a Cargo.lock and their publish times, shared by the
 * lockfile release-age check (scripts/check-lockfile-release-ages.ts) and the
 * quarantine-respecting update (scripts/cargo-update.ts).
 *
 * Cargo has no release-age gate of its own: `cargo update` takes a version
 * published seconds ago. Resolution only rewrites Cargo.lock and runs no crate
 * code (build scripts and proc macros run at build time), so checking the lock
 * between resolve and build is as strong as a resolve-time quarantine. Crates
 * are held to the root bunfig.toml's `minimumReleaseAge`; a temporary
 * `minimumReleaseAgeExcludes` entry named `cargo:<crate>` exempts one crate.
 * npm names cannot contain a colon, so Bun never matches such an entry.
 */

const CRATES_IO_API = "https://crates.io/api/v1";
/** How Cargo.lock records crates.io, whichever index protocol resolved it. */
export const CRATES_IO_SOURCE =
  "registry+https://github.com/rust-lang/crates.io-index";
/** crates.io refuses requests without a User-Agent naming the client. */
const USER_AGENT =
  "stella-lockfile-release-age-check (https://github.com/stella/stella)";
const CARGO_EXCLUDE_PREFIX = "cargo:";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
/** Upper bound on version-list pages for one crate (100 versions each). */
const MAX_VERSION_PAGES = 50;

export type CratePin = { name: string; version: string };

/** The `minimumReleaseAgeExcludes` entry that exempts a crate. */
export const cargoExcludeName = (crate: string): string =>
  `${CARGO_EXCLUDE_PREFIX}${crate}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type CargoLockPins = {
  errors: string[];
  /** Git sources, which have no release age. */
  external: string[];
  pins: CratePin[];
};

/**
 * Every crates.io pin a Cargo.lock resolves. A package without a `source` is
 * a workspace member or path dependency; a `git+` source has no release age
 * and is reported; any other registry cannot be verified here.
 */
export const readCargoLockPins = (
  lockText: string,
  label: string,
): CargoLockPins => {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(lockText);
  } catch (error) {
    return {
      errors: [`${label} does not parse: ${String(error)}`],
      external: [],
      pins: [],
    };
  }
  const packages = isRecord(parsed) ? parsed["package"] : undefined;
  if (!Array.isArray(packages)) {
    return {
      errors: [`${label} has no [[package]] entries`],
      external: [],
      pins: [],
    };
  }

  const errors: string[] = [];
  const external = new Set<string>();
  const pins = new Map<string, CratePin>();
  for (const [index, entry] of packages.entries()) {
    const name = isRecord(entry) ? entry["name"] : undefined;
    const version = isRecord(entry) ? entry["version"] : undefined;
    const source = isRecord(entry) ? entry["source"] : undefined;
    if (typeof name !== "string" || typeof version !== "string") {
      errors.push(
        `${label} package #${String(index + 1)} has no name and version`,
      );
      continue;
    }
    const id = `${name}@${version}`;
    if (source === undefined) {
      continue;
    }
    if (typeof source === "string" && source.startsWith("git+")) {
      external.add(`${id} (${source})`);
      continue;
    }
    if (source !== CRATES_IO_SOURCE) {
      errors.push(
        `${label} package ${id} resolves from a source this check cannot verify: ${typeof source === "string" ? source : JSON.stringify(source)}`,
      );
      continue;
    }
    if (!SEMVER.test(version)) {
      errors.push(`${label} package ${id} has an unrecognized version`);
      continue;
    }
    pins.set(id, { name, version });
  }
  return {
    errors,
    external: [...external].toSorted(),
    pins: [...pins.values()],
  };
};

type Failure = { kind: "failed"; message: string; retryable: boolean };

export type PublishTimeLookup =
  { kind: "published"; publishedAt: Date } | Failure;

export type CrateVersion = {
  publishedAt: Date;
  version: string;
  yanked: boolean;
};

type VersionList = { kind: "loaded"; versions: CrateVersion[] } | Failure;

export type CratesIoClient = {
  /** Publish time of one version: `GET /crates/<name>/<version>`. */
  publishTime: (pin: CratePin) => Promise<PublishTimeLookup>;
  /** Every published version, newest semver first. */
  versions: (name: string) => Promise<VersionList>;
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const readVersion = (value: unknown): CrateVersion | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { created_at: createdAt, num, yanked } = value;
  const publishedMs =
    typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  return typeof num === "string" &&
    typeof yanked === "boolean" &&
    !Number.isNaN(publishedMs)
    ? { publishedAt: new Date(publishedMs), version: num, yanked }
    : undefined;
};

/**
 * crates.io API reads, within its data-access policy: a User-Agent on every
 * request and at most one request per `intervalMs`. Transient failures
 * (network, timeouts, 429, 5xx) are retried; each answer is cached per run.
 */
export const createCratesIoClient = ({
  attempts = 3,
  fetch: fetchImpl = fetch,
  intervalMs = 1000,
  retryDelayMs = 1000,
  timeoutMs = 60_000,
}: {
  attempts?: number;
  fetch?: Fetch;
  intervalMs?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
} = {}): CratesIoClient => {
  let nextStart = 0;
  /** Reserves the next start slot, at least `intervalMs` after the last. */
  const paced = async (): Promise<void> => {
    const start = Math.max(Date.now(), nextStart);
    nextStart = start + intervalMs;
    const wait = start - Date.now();
    if (wait > 0) {
      await Bun.sleep(wait);
    }
  };

  const getOnce = async (
    url: string,
  ): Promise<{ body: unknown; kind: "loaded" } | Failure> => {
    await paced();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        kind: "failed",
        message: `request failed: ${String(error)}`,
        retryable: true,
      };
    }
    if (!response.ok) {
      return {
        kind: "failed",
        message: `crates.io answered HTTP ${String(response.status)}`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    try {
      return { body: await response.json(), kind: "loaded" };
    } catch (error) {
      return {
        kind: "failed",
        message: `unreadable crates.io response: ${String(error)}`,
        retryable: true,
      };
    }
  };

  const get = async (url: string) => {
    let result = await getOnce(url);
    for (
      let attempt = 1;
      attempt < attempts && result.kind === "failed" && result.retryable;
      attempt++
    ) {
      await Bun.sleep(retryDelayMs * attempt);
      result = await getOnce(url);
    }
    return result;
  };

  const crateUrl = (name: string) =>
    `${CRATES_IO_API}/crates/${encodeURIComponent(name)}`;

  const publishTimes = new Map<string, Promise<PublishTimeLookup>>();
  const versionLists = new Map<string, Promise<VersionList>>();

  const loadPublishTime = async ({
    name,
    version,
  }: CratePin): Promise<PublishTimeLookup> => {
    const result = await get(
      `${crateUrl(name)}/${encodeURIComponent(version)}`,
    );
    if (result.kind === "failed") {
      return result;
    }
    const parsed = isRecord(result.body)
      ? readVersion(result.body["version"])
      : undefined;
    return parsed === undefined || parsed.version !== version
      ? {
          kind: "failed",
          message: `crates.io lists no publish time for ${version}`,
          retryable: false,
        }
      : { kind: "published", publishedAt: parsed.publishedAt };
  };

  const loadVersions = async (name: string): Promise<VersionList> => {
    const versions: CrateVersion[] = [];
    let query: string | undefined = "?per_page=100&sort=semver";
    for (let page = 0; query !== undefined; page++) {
      if (page === MAX_VERSION_PAGES) {
        return {
          kind: "failed",
          message: `crates.io lists more than ${String(MAX_VERSION_PAGES * 100)} versions of ${name}`,
          retryable: false,
        };
      }
      const result = await get(`${crateUrl(name)}/versions${query}`);
      if (result.kind === "failed") {
        return result;
      }
      const body = isRecord(result.body) ? result.body : {};
      const list = body["versions"];
      const meta = body["meta"];
      if (!Array.isArray(list) || !isRecord(meta)) {
        return {
          kind: "failed",
          message: `crates.io answered an unreadable version list for ${name}`,
          retryable: false,
        };
      }
      for (const item of list) {
        const parsed = readVersion(item);
        if (parsed === undefined) {
          return {
            kind: "failed",
            message: `crates.io answered an unreadable version of ${name}`,
            retryable: false,
          };
        }
        versions.push(parsed);
      }
      const next = meta["next_page"];
      query = typeof next === "string" && next !== "" ? next : undefined;
    }
    return {
      kind: "loaded",
      versions: versions.toSorted((a, b) =>
        Bun.semver.order(b.version, a.version),
      ),
    };
  };

  return {
    publishTime: async (pin) => {
      const key = `${pin.name}@${pin.version}`;
      let lookup = publishTimes.get(key);
      if (lookup === undefined) {
        lookup = loadPublishTime(pin);
        publishTimes.set(key, lookup);
      }
      return lookup;
    },
    versions: async (name) => {
      let list = versionLists.get(name);
      if (list === undefined) {
        list = loadVersions(name);
        versionLists.set(name, list);
      }
      return list;
    },
  };
};
