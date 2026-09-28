import { panic } from "better-result";

import {
  GENERATORS,
  GUARD_A_EXCLUSIONS,
  matchesGeneratedGlob,
  orderGenerators,
} from "./generated-files";

const ROOT = new URL("..", import.meta.url);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const splitPaths = (value: Uint8Array) =>
  decode(value).split("\0").filter(Boolean);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isGeneratedCandidate = (file: string, header: string): boolean => {
  if (/\.(?:gen|generated)\.[^./]+$/u.test(file)) {
    return true;
  }
  return header
    .split("\n")
    .slice(0, 10)
    .some((line) =>
      /^\s*(?:\/\/|\/\*+|\*|#|<!--)\s*(?:(?:this file (?:was |is )?(?:automatically )?)?@?generated\b|auto-generated\b|code generated\b|rendered from\b|.*(?:@generated\b|\bdo not edit\b))/iu.test(
        line,
      ),
    );
};

export const isRegisteredGeneratedFile = (file: string): boolean =>
  GENERATORS.some((generator) =>
    generator.outputs.some((glob) => matchesGeneratedGlob(glob, file)),
  ) || GUARD_A_EXCLUSIONS.some(({ glob }) => matchesGeneratedGlob(glob, file));

export const isUnregisteredGeneratedFile = (
  file: string,
  header: string,
): boolean =>
  isGeneratedCandidate(file, header) && !isRegisteredGeneratedFile(file);

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: ROOT.pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(`git ${args.at(0) ?? ""} failed: ${decode(result.stderr)}`);
  }
  return result.stdout;
};

const guardA = async () => {
  const files = splitPaths(git(["ls-files", "-z"]));
  const suspected = new Set(
    files.filter((file) => /\.(?:gen|generated)\.[^./]+$/u.test(file)),
  );
  const grep = Bun.spawnSync(
    ["git", "grep", "-IlzE", "@generated|generated|do not edit", "--", "."],
    { cwd: ROOT.pathname, stdout: "pipe", stderr: "pipe" },
  );
  if (grep.exitCode !== 0 && grep.exitCode !== 1) {
    panic(`git grep failed: ${decode(grep.stderr)}`);
  }
  for (const file of splitPaths(grep.stdout)) {
    suspected.add(file);
  }
  const unregistered: string[] = [];
  for (const file of suspected) {
    const header = await Bun.file(new URL(file, ROOT)).slice(0, 4096).text();
    if (isUnregisteredGeneratedFile(file, header)) {
      unregistered.push(file);
    }
  }
  if (unregistered.length > 0) {
    panic(
      `Unregistered generated files:\n${unregistered.toSorted().join("\n")}`,
    );
  }
  console.log(`Guard A: ${suspected.size} candidates registered or excluded`);
};

export const routeGeneratorVersionsMatch = (
  direct: unknown,
  pluginVersion: unknown,
  resolved: unknown,
): boolean =>
  typeof direct === "string" &&
  typeof pluginVersion === "string" &&
  direct === pluginVersion &&
  resolved === `@tanstack/router-generator@${direct}`;

const checkRouteGeneratorVersion = async () => {
  const webPackage: unknown = await Bun.file(
    new URL("apps/web/package.json", ROOT),
  ).json();
  const lock: unknown = Bun.JSONC.parse(
    await Bun.file(new URL("bun.lock", ROOT)).text(),
  );
  if (
    !isRecord(webPackage) ||
    !isRecord(webPackage["devDependencies"]) ||
    !isRecord(lock) ||
    !isRecord(lock["packages"])
  ) {
    panic("Cannot read web dependencies or Bun lockfile");
  }
  const direct = webPackage["devDependencies"]["@tanstack/router-generator"];
  const script = Bun.file(
    new URL("apps/web/scripts/generate-route-tree.ts", ROOT),
  );
  if (!(await script.exists())) {
    return;
  }
  const plugin = lock["packages"]["@tanstack/router-plugin"];
  const generator = lock["packages"]["@tanstack/router-generator"];
  if (
    !Array.isArray(plugin) ||
    !isRecord(plugin[2]) ||
    !isRecord(plugin[2]["dependencies"]) ||
    !Array.isArray(generator)
  ) {
    panic("Cannot resolve TanStack router generator from bun.lock");
  }
  const pluginVersion = plugin[2]["dependencies"]["@tanstack/router-generator"];
  const resolved = generator[0];
  if (!routeGeneratorVersionsMatch(direct, pluginVersion, resolved)) {
    panic(
      "The direct router-generator pin must equal the router-plugin version resolved in bun.lock",
    );
  }
};

const checkManifest = async () => {
  const ids = new Set<string>();
  for (const generator of orderGenerators(GENERATORS)) {
    if (
      ids.has(generator.id) ||
      generator.outputs.length === 0 ||
      generator.inputs.length === 0 ||
      generator.write.length === 0
    ) {
      panic(`Invalid generator entry: ${generator.id}`);
    }
    ids.add(generator.id);
    if (generator.check === null && !generator.checkedBy) {
      panic(`Generator ${generator.id} has no check or named guard`);
    }
    for (const block of generator.blocks ?? []) {
      if (
        !generator.outputs.some((glob) =>
          matchesGeneratedGlob(glob, block.path),
        )
      ) {
        panic(`Block ${block.path} is outside ${generator.id} outputs`);
      }
      const contents = await Bun.file(new URL(block.path, ROOT)).text();
      const begin = contents.indexOf(block.begin);
      const end = contents.indexOf(block.end);
      if (
        begin === -1 ||
        end <= begin ||
        contents.includes(block.begin, begin + 1) ||
        contents.includes(block.end, end + 1)
      ) {
        panic(`Block markers are missing or repeated: ${block.path}`);
      }
    }
  }
  for (const generator of GENERATORS) {
    for (const dependency of generator.after) {
      if (!ids.has(dependency)) {
        panic(`Generator ${generator.id} orders after unknown ${dependency}`);
      }
    }
  }
  orderGenerators(GENERATORS);
  for (const exclusion of GUARD_A_EXCLUSIONS) {
    if (exclusion.reason.trim() === "") {
      panic(`Guard A exclusion ${exclusion.glob} needs a reason`);
    }
  }
  await checkRouteGeneratorVersion();
  console.log(`Manifest: ${GENERATORS.length} generator families`);
};

const guardB = () => {
  for (const generator of orderGenerators(GENERATORS)) {
    if (!generator.check) {
      continue;
    }
    console.log(`Checking ${generator.id}`);
    const result = Bun.spawnSync([...generator.check], {
      cwd: ROOT.pathname,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      panic(`Generator check failed: ${generator.id}`);
    }
  }
};

if (import.meta.main) {
  const mode = process.argv.at(2);
  switch (mode) {
    case "--guard-a":
      await checkManifest();
      await guardA();
      break;
    case "--guard-b":
      await checkManifest();
      guardB();
      break;
    case "--check":
      await checkManifest();
      await guardA();
      guardB();
      break;
    default:
      panic(
        "Usage: bun scripts/generated-files-guard.ts --guard-a|--guard-b|--check",
      );
  }
}
