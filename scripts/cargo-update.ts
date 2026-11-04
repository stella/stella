/**
 * Update crates in a Cargo.lock without taking a release younger than the
 * quarantine, the resolve-time counterpart of the Cargo.lock release-age
 * check in scripts/check-lockfile-release-ages.ts.
 *
 * Cargo has no release-age gate: `cargo update` takes a version published
 * seconds ago. This runs `cargo update -p <crate>...`, then, for every
 * crates.io pin that is new or changed and younger than the root
 * bunfig.toml's `minimumReleaseAge` (transitive ones included), pins it back
 * with `cargo update -p <name>@<version> --precise <newest aged version>`,
 * repeating until the lock holds no young pin. When no aged version satisfies
 * the requirements, the original Cargo.lock is restored and the run fails.
 * Crates with an active `"cargo:<crate>"` exclude in the root bunfig.toml
 * are left as resolved, as the check admits them.
 *
 * It only resolves: it never builds, checks or tests, so no crate code runs.
 *
 * Run: `bun run cargo:update --manifest-path <Cargo.toml> <crate>... [--now <iso>]`
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  isExcludedAt,
  readReleaseAgePolicy,
} from "./check-lockfile-release-ages";
import {
  cargoExcludeName,
  type CratePin,
  type CratesIoClient,
  createCratesIoClient,
  readCargoLockPins,
} from "./crates-io-release-age";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ROOT_BUNFIG = "bunfig.toml";
/**
 * Pin-back rounds before giving up. Each round lowers one young pin, then
 * rereads the lock: lowering one crate can move or drop another.
 */
const MAX_ROUNDS = 100;
/** Older versions tried per young pin before giving up. */
const MAX_CANDIDATES = 20;

type CargoResult = { ok: boolean; output: string };
export type RunCargo = (args: readonly string[]) => CargoResult;

type Lockfile = {
  read: () => string;
  write: (text: string) => void;
};

export type CargoUpdateOutcome =
  | { kind: "updated"; log: string[] }
  | { kind: "failed"; log: string[]; message: string };

const pinId = ({ name, version }: CratePin) => `${name}@${version}`;

const isPrerelease = (version: string) => version.includes("-");

/**
 * The resolve loop, with cargo, the lockfile and crates.io injected so it can
 * run against fakes. Restores the original lockfile on every failure.
 */
export const updateCrates = async ({
  cargo,
  client,
  crates,
  lockfile,
  manifestPath,
  minimumReleaseAgeSeconds,
  isExcluded,
  now,
}: {
  cargo: RunCargo;
  client: CratesIoClient;
  crates: readonly string[];
  /** Whether an active exclude admits this `minimumReleaseAgeExcludes` name. */
  isExcluded: (excludeName: string) => boolean;
  lockfile: Lockfile;
  manifestPath: string;
  minimumReleaseAgeSeconds: number;
  now: Date;
}): Promise<CargoUpdateOutcome> => {
  const original = lockfile.read();
  const log: string[] = [];
  const fail = (message: string): CargoUpdateOutcome => {
    lockfile.write(original);
    return {
      kind: "failed",
      log,
      message: `${message}\nRestored the original Cargo.lock.`,
    };
  };
  const ageMs = minimumReleaseAgeSeconds * 1000;
  const isAged = (publishedAt: Date) =>
    publishedAt.getTime() + ageMs <= now.getTime();

  const update = cargo([
    "update",
    "--manifest-path",
    manifestPath,
    ...crates.flatMap((name) => ["-p", name]),
  ]);
  if (!update.ok) {
    return fail(`cargo update failed:\n${update.output}`);
  }

  const known = new Set(
    readCargoLockPins(original, "Cargo.lock (original)").pins.map(pinId),
  );
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const current = readCargoLockPins(lockfile.read(), "Cargo.lock");
    if (current.errors.length > 0) {
      return fail(current.errors.join("\n"));
    }
    const added = current.pins.filter(
      (pin) =>
        !known.has(pinId(pin)) && !isExcluded(cargoExcludeName(pin.name)),
    );
    let pin: CratePin | undefined;
    for (const candidate of added) {
      const published = await client.publishTime(candidate);
      if (published.kind === "failed") {
        return fail(
          `Could not read the publish time of ${pinId(candidate)}: ${published.message}`,
        );
      }
      if (!isAged(published.publishedAt)) {
        pin = candidate;
        break;
      }
    }
    if (pin === undefined) {
      log.push(
        `Cargo.lock holds no new pin younger than the ${String(minimumReleaseAgeSeconds / 86_400)}-day quarantine.`,
      );
      return { kind: "updated", log };
    }

    const young = pin;
    const listed = await client.versions(young.name);
    if (listed.kind === "failed") {
      return fail(
        `Could not list the versions of ${young.name}: ${listed.message}`,
      );
    }
    const candidates = listed.versions
      .filter(
        (candidate) =>
          !candidate.yanked &&
          isAged(candidate.publishedAt) &&
          Bun.semver.order(candidate.version, young.version) < 0 &&
          (isPrerelease(young.version) || !isPrerelease(candidate.version)),
      )
      .slice(0, MAX_CANDIDATES);
    const refusals: string[] = [];
    let pinned: string | undefined;
    for (const candidate of candidates) {
      const result = cargo([
        "update",
        "--manifest-path",
        manifestPath,
        "-p",
        pinId(young),
        "--precise",
        candidate.version,
      ]);
      if (result.ok) {
        pinned = candidate.version;
        break;
      }
      refusals.push(`  ${candidate.version}: ${result.output.trim()}`);
    }
    if (pinned === undefined) {
      const tried =
        refusals.length === 0
          ? " (crates.io lists none)."
          : `:\n${refusals.join("\n")}`;
      return fail(
        `${pinId(young)} is younger than the quarantine, and no older ` +
          `published version that has cleared it satisfies the dependency ` +
          `requirements${tried}\nUpdate the crate that requires it to an ` +
          `older version, wait until it clears the quarantine, or add a ` +
          `reasoned temporary "${cargoExcludeName(young.name)}" exclude to ` +
          `${ROOT_BUNFIG}.`,
      );
    }
    log.push(
      `Pinned ${young.name} back from ${young.version} (inside the quarantine) to ${pinned}.`,
    );
  }
  return fail(
    `Cargo.lock still holds young pins after ${String(MAX_ROUNDS)} rounds of pinning back.`,
  );
};

const usage: () => never = () => {
  console.error(
    "usage: bun run cargo:update --manifest-path <Cargo.toml> <crate>... [--now <iso>]",
  );
  return process.exit(2);
};

const main = async () => {
  const args = Bun.argv.slice(2);
  let manifestPath: string | undefined;
  let nowText: string | undefined;
  const crates: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--manifest-path") {
      manifestPath = args[++index];
    } else if (arg === "--now") {
      nowText = args[++index];
    } else if (arg === undefined || arg.startsWith("-")) {
      usage();
    } else {
      crates.push(arg);
    }
  }
  if (manifestPath === undefined || crates.length === 0) {
    usage();
  }
  const now = nowText === undefined ? new Date() : new Date(nowText);
  if (Number.isNaN(now.getTime())) {
    console.error(`--now is not a timestamp: ${String(nowText)}`);
    process.exit(2);
  }

  const lockPath = path.join(
    path.dirname(path.resolve(manifestPath)),
    "Cargo.lock",
  );
  if (!existsSync(lockPath)) {
    console.error(`${lockPath} does not exist.`);
    process.exit(2);
  }
  const policy = readReleaseAgePolicy(
    ROOT_BUNFIG,
    readFileSync(path.join(REPO_ROOT, ROOT_BUNFIG), "utf-8"),
  );
  if (policy === undefined) {
    console.error(`${ROOT_BUNFIG} sets no [install] minimumReleaseAge.`);
    process.exit(2);
  }

  const outcome = await updateCrates({
    cargo: (cargoArgs) => {
      console.log(`$ cargo ${cargoArgs.join(" ")}`);
      const result = Bun.spawnSync(["cargo", ...cargoArgs], {
        stderr: "pipe",
        stdout: "pipe",
      });
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      process.stdout.write(output);
      return { ok: result.exitCode === 0, output };
    },
    client: createCratesIoClient(),
    crates,
    isExcluded: (name) => isExcludedAt(policy, name, now),
    lockfile: {
      read: () => readFileSync(lockPath, "utf-8"),
      write: (text) => {
        writeFileSync(lockPath, text);
      },
    },
    manifestPath,
    minimumReleaseAgeSeconds: policy.minimumReleaseAgeSeconds,
    now,
  });
  for (const line of outcome.log) {
    console.log(line);
  }
  if (outcome.kind === "failed") {
    console.error(`\n${outcome.message}`);
    process.exit(1);
  }
};

if (import.meta.main) {
  await main();
}
