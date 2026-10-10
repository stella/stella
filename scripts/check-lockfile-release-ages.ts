/**
 * Guard the release-age quarantine for pins committed straight into a lockfile.
 *
 * Bun applies `minimumReleaseAge` only while it resolves versions (`bun add`,
 * `bun update`, a non-frozen install). `bun install --frozen-lockfile` and
 * `bun ci` install whatever bun.lock pins without looking at publish times,
 * so a too-young version that reaches a lockfile any other way (a hand edit,
 * a tool run without the bunfig, a merge resolution) installs silently in CI
 * and in production builds.
 *
 * This check closes that gap for every tracked bun.lock. It collects the
 * registry pins that are new against the merge base, looks up each one's npm
 * publish time, and fails when one has not yet cleared the quarantine the
 * lockfile is installed under. It applies the rules exactly as Bun does:
 *
 * - Bun reads bunfig.toml only from the directory it installs in (it does not
 *   walk up), so each lockfile is governed by the bunfig.toml beside it. A
 *   changed lockfile with no quarantine there fails: Bun would not gate it.
 * - A name in that file's `minimumReleaseAgeExcludes` is exempt, matched
 *   exactly, whatever its annotation says. The annotations and the removal of
 *   expired entries belong to scripts/check-stll-quarantine-excludes.ts, whose
 *   parser this check reads the file with.
 * - Only versions from the npm registry have a release age. Workspace, link
 *   and file entries are local; git and tarball sources are reported, not
 *   gated, as Bun does not gate them either.
 *
 * A registry failure fails the check: a pin that could not be verified is not
 * known to be old enough.
 *
 * Run: `bun run check:lockfile-ages [--base <ref>] [--head <ref>] [--now <iso>]`
 *
 * `--base` defaults to origin/main and is diffed from its merge base with the
 * head. Without `--head` the working tree is checked; with it, the lockfiles
 * and bunfigs of that commit. `--now` evaluates the quarantine at another
 * instant, for replaying a past change.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseBunLockText } from "./bun-lock-text";
import {
  readInstallPolicy,
  readTemporaryExcludes,
} from "./check-stll-quarantine-excludes";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LOCKFILE_NAME = "bun.lock";
const BUNFIG_NAME = "bunfig.toml";
const NPM_REGISTRY = "https://registry.npmjs.org";
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
/** Specifier prefixes of entries Bun resolves locally. */
const LOCAL_SOURCES = ["workspace:", "link:", "file:", "root:"];
/** Specifier prefixes of entries fetched from outside the npm registry. */
const EXTERNAL_SOURCES = ["git+", "git:", "github:", "http:", "https:"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type RegistryPin = { name: string; version: string };

type LockfilePins = {
  errors: string[];
  /** Entries fetched from outside the registry, which have no release age. */
  external: string[];
  pins: RegistryPin[];
};

const pinKey = ({ name, version }: RegistryPin): string => `${name}@${version}`;

/**
 * Every npm registry pin a bun.lock resolves. An entry is
 * `[ident, registry, metadata, integrity]` for a registry package, where the
 * ident is `name@version`; other sources carry their specifier in the ident.
 */
export const readLockfilePins = (
  lockText: string,
  label: string,
): LockfilePins => {
  let parsed: unknown;
  try {
    parsed = parseBunLockText(lockText);
  } catch (error) {
    return {
      errors: [`${label} does not parse: ${String(error)}`],
      external: [],
      pins: [],
    };
  }
  const packages = isRecord(parsed) ? parsed["packages"] : undefined;
  if (!isRecord(packages)) {
    return {
      errors: [`${label} has no packages map`],
      external: [],
      pins: [],
    };
  }

  const errors: string[] = [];
  const external = new Set<string>();
  const pins = new Map<string, RegistryPin>();
  for (const [key, entry] of Object.entries(packages)) {
    const ident = Array.isArray(entry) ? entry.at(0) : undefined;
    // A package name holds no `@` past a scope's leading one, while a source
    // specifier can (git+ssh://git@host/...), so split at the first one.
    const separator = typeof ident === "string" ? ident.indexOf("@", 1) : -1;
    if (typeof ident !== "string" || separator <= 0) {
      errors.push(`${label} package "${key}" has no name@specifier ident`);
      continue;
    }
    const name = ident.slice(0, separator);
    const specifier = ident.slice(separator + 1);
    if (LOCAL_SOURCES.some((prefix) => specifier.startsWith(prefix))) {
      continue;
    }
    if (EXTERNAL_SOURCES.some((prefix) => specifier.startsWith(prefix))) {
      external.add(ident);
      continue;
    }
    if (!EXACT_VERSION.test(specifier)) {
      errors.push(
        `${label} package "${key}" has an unrecognized specifier: ${ident}`,
      );
      continue;
    }
    // A non-empty second field names a registry other than the default one.
    // Its answers cannot be trusted to vouch for a publish time, and nothing
    // here resolves from one, so an entry that does is not verifiable.
    const registry = Array.isArray(entry) ? entry.at(1) : undefined;
    if (
      registry !== "" &&
      registry !== NPM_REGISTRY &&
      registry !== `${NPM_REGISTRY}/`
    ) {
      errors.push(
        `${label} package "${key}" (${ident}) resolves from a registry this ` +
          `check cannot verify: ${String(registry)}`,
      );
      continue;
    }
    const pin = { name, version: specifier };
    pins.set(pinKey(pin), pin);
  }
  return {
    errors,
    external: [...external].toSorted(),
    pins: [...pins.values()],
  };
};

type ReleaseAgePolicy = {
  bunfigPath: string;
  excludes: ReadonlySet<string>;
  minimumReleaseAgeSeconds: number;
  /** Annotated instant of each temporary exclude, for the report. */
  temporaryExpiries: ReadonlyMap<string, string>;
};

/** The bunfig.toml Bun reads when installing the lockfile's directory. */
export const governingBunfigPath = (lockfilePath: string): string =>
  path.posix.join(path.posix.dirname(lockfilePath), BUNFIG_NAME);

const readReleaseAgePolicy = (
  bunfigPath: string,
  bunfigText: string | undefined,
): ReleaseAgePolicy | undefined => {
  if (bunfigText === undefined) {
    return undefined;
  }
  const { excludes, minimumReleaseAge } = readInstallPolicy(bunfigText);
  if (minimumReleaseAge === undefined) {
    return undefined;
  }
  return {
    bunfigPath,
    excludes,
    minimumReleaseAgeSeconds: minimumReleaseAge,
    temporaryExpiries: new Map(
      readTemporaryExcludes(bunfigText).entries.map(({ expiresAt, name }) => [
        name,
        expiresAt,
      ]),
    ),
  };
};

type PublishTimeLookup =
  | { kind: "published"; publishedAt: Date }
  | { kind: "failed"; message: string; retryable: boolean };

type LookupPublishTime = (pin: RegistryPin) => Promise<PublishTimeLookup>;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const packumentUrl = (name: string): string =>
  // A scoped name keeps its `@` and escapes the slash, as the registry expects.
  `${NPM_REGISTRY}/${encodeURIComponent(name).replace(/^%40/u, "@")}`;

type Packument =
  | { kind: "loaded"; time: Readonly<Record<string, unknown>> }
  | { kind: "failed"; message: string; retryable: boolean };

/**
 * Publish times from the registry's full packument: the abbreviated install
 * metadata carries no `time` map. One request per package name per run,
 * shared by every version of it; at most `concurrency` in flight; transient
 * failures (network, timeouts, 429, 5xx) are retried.
 */
export const createRegistryLookup = ({
  attempts = 3,
  concurrency = 8,
  fetch: fetchImpl = fetch,
  retryDelayMs = 1000,
  timeoutMs = 60_000,
}: {
  attempts?: number;
  concurrency?: number;
  fetch?: Fetch;
  retryDelayMs?: number;
  timeoutMs?: number;
} = {}): LookupPublishTime => {
  const packuments = new Map<string, Promise<Packument>>();
  let active = 0;
  const waiting: (() => void)[] = [];

  const withSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    }
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };

  const fetchOnce = async (name: string): Promise<Packument> => {
    let response: Response;
    try {
      response = await fetchImpl(packumentUrl(name), {
        headers: { accept: "application/json" },
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
        message: `registry answered HTTP ${String(response.status)}`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return {
        kind: "failed",
        message: `unreadable registry response: ${String(error)}`,
        retryable: true,
      };
    }
    const time = isRecord(body) ? body["time"] : undefined;
    return isRecord(time)
      ? { kind: "loaded", time }
      : {
          kind: "failed",
          message: "registry response has no publish times",
          retryable: false,
        };
  };

  const loadPackument = async (name: string): Promise<Packument> => {
    let result = await withSlot(async () => fetchOnce(name));
    for (
      let attempt = 1;
      attempt < attempts && result.kind === "failed" && result.retryable;
      attempt++
    ) {
      await Bun.sleep(retryDelayMs * attempt);
      result = await withSlot(async () => fetchOnce(name));
    }
    return result;
  };

  return async ({ name, version }) => {
    let packument = packuments.get(name);
    if (packument === undefined) {
      packument = loadPackument(name);
      packuments.set(name, packument);
    }
    const loaded = await packument;
    if (loaded.kind === "failed") {
      return loaded;
    }
    const publishedAt = loaded.time[version];
    const publishedMs =
      typeof publishedAt === "string" ? Date.parse(publishedAt) : Number.NaN;
    return Number.isNaN(publishedMs)
      ? {
          kind: "failed",
          message: `the registry lists no publish time for ${version}`,
          retryable: false,
        }
      : { kind: "published", publishedAt: new Date(publishedMs) };
  };
};

export type LockfileInput = {
  /** Lockfile text at the merge base; undefined when it did not exist. */
  baseText: string | undefined;
  bunfigText: string | undefined;
  headText: string;
  path: string;
};

type ReleaseAgeReport = {
  /** Pins that were checked, one line each, for the log. */
  checked: string[];
  errors: string[];
  notes: string[];
  /** Pins not yet out of quarantine. */
  quarantined: string[];
  /** Pins whose publish time could not be read. */
  unverified: string[];
};

const DAY_SECONDS = 24 * 60 * 60;

const describeAge = (seconds: number): string =>
  seconds % DAY_SECONDS === 0
    ? `${String(seconds / DAY_SECONDS)}-day`
    : `${String(seconds)}-second`;

export const checkLockfileReleaseAges = async ({
  lockfiles,
  lookup,
  now,
  packageName,
}: {
  packageName?: string;
  lockfiles: readonly LockfileInput[];
  lookup: LookupPublishTime;
  now: Date;
}): Promise<ReleaseAgeReport> => {
  const report: ReleaseAgeReport = {
    checked: [],
    errors: [],
    notes: [],
    quarantined: [],
    unverified: [],
  };

  let selectedPins = 0;
  for (const lockfile of lockfiles) {
    const head = readLockfilePins(lockfile.headText, lockfile.path);
    const base =
      lockfile.baseText === undefined
        ? undefined
        : readLockfilePins(lockfile.baseText, `${lockfile.path} (base)`);
    report.errors.push(...head.errors);
    const known = new Set((base?.pins ?? []).map(pinKey));
    const added = head.pins.filter(
      (pin) =>
        !known.has(pinKey(pin)) &&
        (packageName === undefined || pin.name === packageName),
    );
    selectedPins += added.length;
    const knownExternal = new Set(base?.external);
    for (const ident of head.external) {
      if (!knownExternal.has(ident)) {
        report.notes.push(
          `${lockfile.path}: ${ident} is not from the npm registry; it has no release age to check.`,
        );
      }
    }
    if (added.length === 0) {
      continue;
    }

    const bunfigPath = governingBunfigPath(lockfile.path);
    const policy = readReleaseAgePolicy(bunfigPath, lockfile.bunfigText);
    if (policy === undefined) {
      report.errors.push(
        `${lockfile.path} adds ${String(added.length)} pin(s) but no release-age ` +
          `quarantine governs it: Bun reads ${BUNFIG_NAME} only from the ` +
          `directory it installs in, and ${bunfigPath} sets no ` +
          `[install] minimumReleaseAge. Add one; ` +
          `scripts/check-standalone-lockfiles.ts lists what else a standalone ` +
          `lockfile needs.`,
      );
      continue;
    }

    const ageMs = policy.minimumReleaseAgeSeconds * 1000;
    const quarantine = `${describeAge(policy.minimumReleaseAgeSeconds)} quarantine of ${policy.bunfigPath}`;
    const results = await Promise.all(
      added.map(async (pin) => {
        if (policy.excludes.has(pin.name)) {
          return { outcome: undefined, pin };
        }
        return { outcome: await lookup(pin), pin };
      }),
    );
    for (const { outcome: result, pin } of results) {
      const id = `${lockfile.path}: ${pinKey(pin)}`;
      if (result === undefined) {
        const expiresAt = policy.temporaryExpiries.get(pin.name);
        report.checked.push(
          expiresAt === undefined
            ? `${id} excluded from the quarantine by ${policy.bunfigPath}`
            : `${id} excluded from the quarantine by ${policy.bunfigPath} (temporary, recorded admission ${expiresAt})`,
        );
        continue;
      }
      if (result.kind === "failed") {
        report.unverified.push(`${id}: ${result.message}`);
        continue;
      }
      const publishedAt = result.publishedAt.toISOString();
      const admittedAt = new Date(result.publishedAt.getTime() + ageMs);
      if (now.getTime() < admittedAt.getTime()) {
        report.quarantined.push(
          `${id} was published ${publishedAt}; the ${quarantine} admits it at ${admittedAt.toISOString()}.\n` +
            `    To pin it before then, add a reasoned temporary exclude to ${policy.bunfigPath}:\n` +
            `      "${pin.name}", # quarantine-expires: ${admittedAt.toISOString()}`,
        );
        continue;
      }
      report.checked.push(
        `${id} published ${publishedAt}, cleared the ${quarantine}`,
      );
    }
  }
  if (packageName !== undefined && selectedPins === 0) {
    report.errors.push(
      `No registry pins found for requested package: ${packageName}`,
    );
  }
  return report;
};

type Git = (args: readonly string[]) => { ok: boolean; stdout: string };

const git: Git = (args) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: REPO_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString() };
};

const gitOrExit = (args: readonly string[]): string => {
  const result = git(args);
  if (!result.ok) {
    console.error(`git ${args.join(" ")} failed.`);
    process.exit(2);
  }
  return result.stdout;
};

const readAtRef = (ref: string, file: string): string | undefined => {
  const result = git(["show", `${ref}:${file}`]);
  return result.ok ? result.stdout : undefined;
};

const optionValue = (args: readonly string[], flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const main = async () => {
  const args = Bun.argv.slice(2);
  const baseRef = optionValue(args, "--base") ?? "origin/main";
  const headRef = optionValue(args, "--head");
  const all = args.includes("--all");
  const packageName = optionValue(args, "--package");
  const nowText = optionValue(args, "--now");
  const now = nowText === undefined ? new Date() : new Date(nowText);
  if (Number.isNaN(now.getTime())) {
    console.error(`--now is not a timestamp: ${String(nowText)}`);
    process.exit(2);
  }

  const mergeBase = gitOrExit([
    "merge-base",
    baseRef,
    headRef ?? "HEAD",
  ]).trim();
  const tracked = (
    headRef === undefined
      ? gitOrExit(["ls-files", "-z"])
      : gitOrExit(["ls-tree", "-r", "-z", "--name-only", headRef])
  )
    .split("\0")
    .filter((file) => path.posix.basename(file) === LOCKFILE_NAME);
  const changed = new Set(
    gitOrExit([
      "diff",
      "--name-only",
      "-z",
      mergeBase,
      ...(headRef === undefined ? [] : [headRef]),
      "--",
      ...tracked,
    ])
      .split("\0")
      .filter(Boolean),
  );

  const readHead = (file: string): string | undefined => {
    if (headRef !== undefined) {
      return readAtRef(headRef, file);
    }
    const absolute = path.join(REPO_ROOT, file);
    return existsSync(absolute) ? readFileSync(absolute, "utf-8") : undefined;
  };

  const lockfiles = tracked.flatMap((file): LockfileInput[] => {
    const headText = readHead(file);
    if ((!all && !changed.has(file)) || headText === undefined) {
      return [];
    }
    return [
      {
        baseText: all ? undefined : readAtRef(mergeBase, file),
        bunfigText: readHead(governingBunfigPath(file)),
        headText,
        path: file,
      },
    ];
  });

  if (lockfiles.length === 0) {
    console.log(`No lockfile changed since ${mergeBase.slice(0, 12)}.`);
    return;
  }

  const report = await checkLockfileReleaseAges({
    lockfiles,
    lookup: createRegistryLookup(),
    now,
    ...(packageName === undefined ? {} : { packageName }),
  });

  console.log(
    `Lockfiles changed since ${mergeBase.slice(0, 12)}: ${lockfiles.map((file) => file.path).join(", ")}; quarantine evaluated at ${now.toISOString()}.`,
  );
  for (const line of [...report.checked, ...report.notes]) {
    console.log(`  ${line}`);
  }

  const failures: string[] = [];
  if (report.errors.length > 0) {
    failures.push(report.errors.join("\n"));
  }
  if (report.quarantined.length > 0) {
    failures.push(
      `${String(report.quarantined.length)} new pin(s) have not cleared the release-age quarantine. ` +
        `A frozen install would not stop them, so this check does.\n\n` +
        `${report.quarantined.map((line) => `  ${line}`).join("\n")}\n\n` +
        `Either wait until the admission instant and re-run this check, or add ` +
        `the exclude shown, with a comment giving the reason, to the ` +
        `minimumReleaseAgeExcludes of that bunfig; this check honours it.`,
    );
  }
  if (report.unverified.length > 0) {
    failures.push(
      `Could not read the publish time of ${String(report.unverified.length)} new pin(s), ` +
        `so their release age is unverified:\n` +
        `${report.unverified.map((line) => `  ${line}`).join("\n")}\n\n` +
        `This is usually transient: re-run the check.`,
    );
  }
  if (failures.length > 0) {
    console.error(`\n${failures.join("\n\n")}`);
    process.exit(1);
  }
  console.log(
    `${String(report.checked.length)} new pin(s) cleared the release-age quarantine.`,
  );
};

if (import.meta.main) {
  await main();
}
