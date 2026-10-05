import {
  appendFileSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { parseBunLockText } from "./bun-lock-text";
import {
  checkTauriPackageAlignment,
  readTauriPairs,
  tauriVersionLine,
} from "./check-tauri-package-alignment";
import {
  applyReplacements,
  directPropertyValue,
  rootObjectStart,
  stringTokenAt,
} from "./json-text-edit";

const BUN_LOCK = "bun.lock";
const CARGO_LOCK = "apps/desktop/src-tauri/Cargo.lock";
const CARGO_MANIFEST = "apps/desktop/src-tauri/Cargo.toml";
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const ROOT = realpathSync(path.resolve(import.meta.dirname, ".."));

// This fixer runs before install, like json-text-edit and fix-resolution-ranges.
export class TauriAutofixError extends Error {
  readonly _tag = "TauriAutofixError";
  constructor(message: string) {
    super(message);
    this.name = "TauriAutofixError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Release lines are "major.minor"; numeric collation orders 2.10 after 2.9.
const RELEASE_LINE_ORDER = new Intl.Collator("en", { numeric: true });

type TauriRepair = { crate: string; line: string; npm: string[] };
type PlanTauriRepairsOptions = {
  base: ReturnType<typeof readTauriPairs>;
  head: ReturnType<typeof readTauriPairs>;
};

const lines = (versions: readonly string[]) =>
  [
    ...new Set(
      versions.map(tauriVersionLine).filter((line) => line !== undefined),
    ),
  ]
    .toSorted((left, right) => RELEASE_LINE_ORDER.compare(left, right))
    .join(",");

export const planTauriRepairs = ({ base, head }: PlanTauriRepairsOptions) => {
  const repairs: TauriRepair[] = [];
  const errors = [...base.errors, ...head.errors];
  if (errors.length > 0) {
    return { repairs, errors };
  }
  const crates = new Set(head.pairs.map(({ crate }) => crate));
  for (const crate of crates) {
    const pairs = head.pairs.filter((pair) => pair.crate === crate);
    const before = base.pairs.filter((pair) => pair.crate === crate);
    const crateVersions = pairs.flatMap((pair) => pair.crateVersions);
    const npmVersions = pairs.map((pair) => pair.npmVersion);
    if (lines([...crateVersions, ...npmVersions]).split(",").length === 1) {
      continue;
    }
    const changedLines = new Set<string>();
    if (
      lines(crateVersions) !==
      lines(before.flatMap((pair) => pair.crateVersions))
    ) {
      for (const version of crateVersions) {
        const line = tauriVersionLine(version);
        if (line !== undefined) {
          changedLines.add(line);
        }
      }
    }
    for (const npm of new Set(pairs.map((pair) => pair.npm))) {
      const current = pairs
        .filter((pair) => pair.npm === npm)
        .map((pair) => pair.npmVersion);
      const previous = before
        .filter((pair) => pair.npm === npm)
        .map((pair) => pair.npmVersion);
      if (lines(current) === lines(previous)) {
        continue;
      }
      for (const version of current) {
        const line = tauriVersionLine(version);
        if (line !== undefined) {
          changedLines.add(line);
        }
      }
    }
    const target = [...changedLines].at(0);
    if (changedLines.size !== 1 || target === undefined) {
      errors.push(
        `${crate}: conflicting or unchanged release lines; align manually`,
      );
      continue;
    }
    if (
      [...crateVersions, ...npmVersions].some((version) => {
        const line = tauriVersionLine(version);
        return (
          line !== undefined && RELEASE_LINE_ORDER.compare(line, target) > 0
        );
      })
    ) {
      errors.push(`${crate}: refusing an automatic downgrade to ${target}`);
      continue;
    }
    if (new Set(crateVersions).size !== 1) {
      errors.push(`${crate}: multiple crate resolutions; align manually`);
      continue;
    }
    repairs.push({
      crate,
      line: target,
      npm: [...new Set(pairs.map((pair) => pair.npm))],
    });
  }
  return { repairs, errors };
};

type RegistryVersion = {
  version: string;
  publishedAt: string;
  status: "available" | "yanked";
};
type LatestPatchOptions = {
  versions: readonly RegistryVersion[];
  line: string;
  now: number;
  minimumAge: number;
};

export const latestEligibleTauriPatch = ({
  versions,
  line,
  now,
  minimumAge,
}: LatestPatchOptions) =>
  versions
    .filter(
      (entry) =>
        entry.status === "available" &&
        /^\d+\.\d+\.\d+$/u.test(entry.version) &&
        tauriVersionLine(entry.version) === line &&
        Number.isFinite(Date.parse(entry.publishedAt)) &&
        now - Date.parse(entry.publishedAt) >= minimumAge * 1000,
    )
    .toSorted(
      (left, right) =>
        Number(right.version.split(".").at(2)) -
        Number(left.version.split(".").at(2)),
    )
    .at(0)?.version;

type NpmManifestRepair = { npm: string; version: string };

export const repairTauriNpmManifest = (
  text: string,
  repairs: readonly NpmManifestRepair[],
) => {
  const manifest: unknown = JSON.parse(text);
  if (!isRecord(manifest)) {
    throw new TauriAutofixError("Invalid package.json");
  }
  const replacements = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (!isRecord(dependencies)) {
      continue;
    }
    for (const { npm, version } of repairs) {
      const range = dependencies[npm];
      if (range === undefined) {
        continue;
      }
      if (
        typeof range !== "string" ||
        !/^[~^]?\d+(?:\.\d+){0,2}$/u.test(range)
      ) {
        throw new TauriAutofixError(`${npm}: unsupported dependency range`);
      }
      const root = rootObjectStart(text, "package.json");
      const objectStart = directPropertyValue({
        text,
        objectStart: root,
        property: section,
        label: "package.json",
      });
      const start = directPropertyValue({
        text,
        objectStart,
        property: npm,
        label: section,
      });
      const token = stringTokenAt(text, start);
      // Keep resolution on the selected release line; Bun still enforces age.
      replacements.push({
        start,
        end: token.end,
        value: JSON.stringify(`~${version}`),
      });
    }
  }
  return applyReplacements(text, replacements);
};

export const repairTauriCargoManifest = (
  text: string,
  repair: { crate: string; version: string },
) => {
  const parsed: unknown = Bun.TOML.parse(text);
  if (
    !isRecord(parsed) ||
    !isRecord(parsed["dependencies"]) ||
    parsed["dependencies"][repair.crate] === undefined
  ) {
    throw new TauriAutofixError(
      `${repair.crate}: missing direct Cargo dependency`,
    );
  }
  const escapedCrate = repair.crate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `^(${escapedCrate}\\s*=\\s*(?:\\{\\s*version\\s*=\\s*)?)"[^"]+"`,
    "mu",
  );
  if (!pattern.test(text)) {
    throw new TauriAutofixError(
      `${repair.crate}: unsupported Cargo dependency declaration`,
    );
  }
  const updated = text.replace(
    pattern,
    (_match, prefix: string) => `${prefix}"~${repair.version}"`,
  );
  const verified: unknown = Bun.TOML.parse(updated);
  if (!isRecord(verified) || !isRecord(verified["dependencies"])) {
    throw new TauriAutofixError("Invalid Cargo.toml repair");
  }
  const dependency = verified["dependencies"][repair.crate];
  const range = isRecord(dependency) ? dependency["version"] : dependency;
  if (range !== `~${repair.version}`) {
    throw new TauriAutofixError(
      `${repair.crate}: repair did not change its dependency`,
    );
  }
  return updated;
};

const run = (args: [string, ...string[]]) => {
  const result = Bun.spawnSync(args, {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new TauriAutofixError(`${args[0]} failed (exit ${result.exitCode})`);
  }
};

export const readTauriRegistryVersions = (
  data: unknown,
  ecosystem: "npm" | "cargo",
) => {
  if (!isRecord(data)) {
    throw new TauriAutofixError("Invalid registry response");
  }
  const versions: RegistryVersion[] = [];
  if (ecosystem === "npm") {
    const published = data["time"];
    const available = data["versions"];
    if (!isRecord(published) || !isRecord(available)) {
      throw new TauriAutofixError("Missing npm versions/publish times");
    }
    for (const version of Object.keys(available)) {
      const publishedAt = published[version];
      if (typeof publishedAt === "string") {
        versions.push({ version, publishedAt, status: "available" });
      }
    }
    return versions;
  }
  if (!Array.isArray(data["versions"])) {
    throw new TauriAutofixError("Missing crate versions");
  }
  for (const entry of data["versions"]) {
    if (
      !isRecord(entry) ||
      typeof entry["num"] !== "string" ||
      typeof entry["created_at"] !== "string" ||
      typeof entry["yanked"] !== "boolean"
    ) {
      throw new TauriAutofixError("Invalid crate version");
    }
    versions.push({
      version: entry["num"],
      publishedAt: entry["created_at"],
      status: entry["yanked"] ? "yanked" : "available",
    });
  }
  return versions;
};

const registryVersions = async (name: string, ecosystem: "npm" | "cargo") => {
  const url =
    ecosystem === "npm"
      ? `https://registry.npmjs.org/${name}`
      : `https://crates.io/api/v1/crates/${name}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "stella-tauri-alignment" },
  });
  if (!response.ok) {
    throw new TauriAutofixError(
      `${name}: registry returned ${response.status}`,
    );
  }
  const data: unknown = await response.json();
  return readTauriRegistryVersions(data, ecosystem);
};

const fix = async () => {
  const filePath = (relative: string) => {
    const file = path.resolve(ROOT, relative);
    if (!file.startsWith(`${ROOT}${path.sep}`) || realpathSync(file) !== file) {
      throw new TauriAutofixError(
        `${relative}: symlink or path outside repository`,
      );
    }
    return file;
  };
  const base = Bun.env["BASE_SHA"];
  if (base === undefined || !/^[a-f0-9]{40}$/u.test(base)) {
    throw new TauriAutofixError("BASE_SHA must be a commit SHA");
  }
  const readBase = (file: string) => {
    const result = Bun.spawnSync(["git", "show", `${base}:${file}`], {
      cwd: ROOT,
    });
    if (result.exitCode !== 0) {
      throw new TauriAutofixError(`Cannot read base ${file}`);
    }
    return result.stdout.toString();
  };
  const bun = readFileSync(filePath(BUN_LOCK), "utf-8");
  const cargo = readFileSync(filePath(CARGO_LOCK), "utf-8");
  const head = readTauriPairs(bun, cargo);
  const { repairs, errors } = planTauriRepairs({
    base: readTauriPairs(readBase(BUN_LOCK), readBase(CARGO_LOCK)),
    head,
  });
  if (errors.length > 0) {
    throw new TauriAutofixError(errors.join("\n"));
  }
  if (repairs.length === 0) {
    return;
  }
  const policy: unknown = Bun.TOML.parse(
    readFileSync(filePath("bunfig.toml"), "utf-8"),
  );
  const install = isRecord(policy) ? policy["install"] : undefined;
  const minimumAge = isRecord(install)
    ? install["minimumReleaseAge"]
    : undefined;
  if (typeof minimumAge !== "number" || minimumAge < 0) {
    throw new TauriAutofixError("Missing release-age policy");
  }
  const now = Date.now();
  const select = async ({
    name,
    ecosystem,
    line,
  }: {
    name: string;
    ecosystem: "npm" | "cargo";
    line: string;
  }) => {
    const version = latestEligibleTauriPatch({
      versions: await registryVersions(name, ecosystem),
      line,
      now,
      minimumAge,
    });
    if (version === undefined) {
      throw new TauriAutofixError(`${name}: no eligible patch in ${line}`);
    }
    return version;
  };
  const npmRepairs: NpmManifestRepair[] = [];
  const cargoRepairs = [];
  for (const repair of repairs) {
    for (const npm of repair.npm) {
      // Bindings resolve through the CLI's exact optional dependency pins.
      if (npm.startsWith("@tauri-apps/cli-")) {
        continue;
      }
      npmRepairs.push({
        npm,
        version: await select({
          name: npm,
          ecosystem: "npm",
          line: repair.line,
        }),
      });
    }
    cargoRepairs.push({
      crate: repair.crate,
      version: await select({
        name: repair.crate,
        ecosystem: "cargo",
        line: repair.line,
      }),
    });
  }
  const lock = parseBunLockText(bun);
  if (!isRecord(lock) || !isRecord(lock["workspaces"])) {
    throw new TauriAutofixError("Missing Bun workspaces");
  }
  const writes = new Map<string, string>();
  for (const directory of Object.keys(lock["workspaces"])) {
    const file = filePath(path.join(directory, "package.json"));
    const text = readFileSync(file, "utf-8");
    const updated = repairTauriNpmManifest(text, npmRepairs);
    if (updated !== text) {
      writes.set(file, updated);
    }
  }
  const manifest = filePath(CARGO_MANIFEST);
  let cargoManifest = readFileSync(manifest, "utf-8");
  for (const repair of cargoRepairs) {
    cargoManifest = repairTauriCargoManifest(cargoManifest, repair);
  }
  writes.set(manifest, cargoManifest);
  // Resolve every registry target and validate every edit before any write.
  for (const [file, text] of writes) {
    writeFileSync(file, text);
  }
  for (const repair of cargoRepairs) {
    const versions = new Set(
      head.pairs
        .filter((pair) => pair.crate === repair.crate)
        .flatMap((pair) => pair.crateVersions),
    );
    for (const version of versions) {
      run([
        "cargo",
        "update",
        "--manifest-path",
        CARGO_MANIFEST,
        "-p",
        `${repair.crate}@${version}`,
        "--precise",
        repair.version,
      ]);
    }
  }
  run([
    "bun",
    "--no-env-file",
    "install",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  const remaining = checkTauriPackageAlignment(
    readFileSync(filePath(BUN_LOCK), "utf-8"),
    readFileSync(filePath(CARGO_LOCK), "utf-8"),
  );
  if (remaining.length > 0) {
    throw new TauriAutofixError(remaining.join("\n"));
  }
  const output = Bun.env["GITHUB_OUTPUT"];
  if (output !== undefined) {
    const allowed = [...writes.keys()].map((file) => path.relative(ROOT, file));
    allowed.push(BUN_LOCK, CARGO_LOCK);
    if (allowed.some((file) => /[|\r\n]/u.test(file))) {
      throw new TauriAutofixError("Invalid autofix output path");
    }
    appendFileSync(output, `allowed=${allowed.join("|")}\n`);
  }
};

if (import.meta.main) {
  await fix();
}
