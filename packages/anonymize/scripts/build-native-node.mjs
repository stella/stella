import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import languageScopes from "../src/data/language-scopes.json" with { type: "json" };

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));
const pythonNativePackageRoot = join(
  repoRoot,
  "crates",
  "anonymize-py",
  "python",
  "stella_anonymize",
  "native_packages",
);
const DEFAULT_SCOPED_PACKAGE_LANGUAGES = ["cs", "de", "en"];
const DEFAULT_PIPELINE_INPUT_FILE = "default-pipeline-input.json.gz";
const NATIVE_PACKAGE_PATTERN =
  /^native-pipeline(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?\.stlanonpkg$/u;
const scopedPackageLanguages = languageListFromEnv(
  process.env.STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES,
  DEFAULT_SCOPED_PACKAGE_LANGUAGES,
);
const supportedCityCountries = [
  ...new Set(
    Object.values(languageScopes.languages).flatMap(
      ({ denyListCountries }) => denyListCountries,
    ),
  ),
].toSorted();

const sourceByPlatform = {
  darwin: "libstella_anonymize_napi.dylib",
  linux: "libstella_anonymize_napi.so",
  win32: "stella_anonymize_napi.dll",
};

const sourceName = sourceByPlatform[process.platform];
if (!sourceName) {
  throw new Error(`Unsupported native build platform: ${process.platform}`);
}

execFileSync(
  "cargo",
  ["build", "-p", "stella-anonymize-napi", "--release", "--locked"],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

const source = join(repoRoot, "target", "release", sourceName);
if (!existsSync(source)) {
  throw new Error(`Native build output is missing: ${source}`);
}

rmSync(join(packageRoot, "stella_anonymize_napi.node"), { force: true });
const sidecarRoot = nativeSidecarPackageRoot({
  arch: process.arch,
  libc: detectNativeLibc(process.platform),
  platform: process.platform,
});
if (sidecarRoot !== null) {
  copyFileSync(source, join(sidecarRoot, "stella_anonymize_napi.node"));
}
removeNativePipelinePackages(packageRoot);
removeNativePipelinePackages(pythonNativePackageRoot);
mkdirSync(pythonNativePackageRoot, { recursive: true });
await writeDefaultPipelineInput();

const defaultPackagePath = join(packageRoot, "native-pipeline.stlanonpkg");
buildNativePipelinePackage([
  "--out",
  defaultPackagePath,
  "--default-dictionaries",
]);
copyNativePipelinePackageToPython(defaultPackagePath);

for (const language of scopedPackageLanguages) {
  const scopedPackagePath = join(
    packageRoot,
    `native-pipeline.${language}.stlanonpkg`,
  );
  buildNativePipelinePackage([
    "--out",
    scopedPackagePath,
    "--default-dictionaries",
    "--language",
    language,
  ]);
  copyNativePipelinePackageToPython(scopedPackagePath);
}

function buildNativePipelinePackage(args) {
  execFileSync(
    process.execPath,
    [
      join(packageRoot, "scripts", "build-native-pipeline-package.mjs"),
      ...args,
    ],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  );
}

function copyNativePipelinePackageToPython(packagePath) {
  copyFileSync(
    packagePath,
    join(pythonNativePackageRoot, basename(packagePath)),
  );
}

async function writeDefaultPipelineInput() {
  const [
    { DEFAULT_NATIVE_PIPELINE_CONFIG, SUPPORTED_LANGUAGES },
    { loadDictionaryBundle },
  ] = await Promise.all([
    // eslint-disable-next-line stll/no-dynamic-import-specifier -- This build script imports its just-generated local SDK entry by absolute URL.
    import(pathToFileURL(join(packageRoot, "dist", "index.mjs")).href),
    import("@stll/anonymize-data/cities"),
  ]);
  const dictionaries = await loadDictionaryBundle({
    cityCountries: supportedCityCountries,
  });
  const input = JSON.stringify({
    config: DEFAULT_NATIVE_PIPELINE_CONFIG,
    dictionaries,
    supportedLanguages: SUPPORTED_LANGUAGES,
  });
  const outputPath = join(packageRoot, DEFAULT_PIPELINE_INPUT_FILE);
  writeFileSync(outputPath, gzipSync(input));
  copyFileSync(
    outputPath,
    join(pythonNativePackageRoot, DEFAULT_PIPELINE_INPUT_FILE),
  );
}

function removeNativePipelinePackages(root) {
  if (!existsSync(root)) {
    return;
  }
  for (const entry of readdirSync(root)) {
    if (!NATIVE_PACKAGE_PATTERN.test(entry)) {
      continue;
    }
    rmSync(join(root, entry), { force: true });
  }
}

function languageListFromEnv(value, defaultLanguages) {
  if (value === undefined) {
    return defaultLanguages;
  }
  if (value.trim().length === 0) {
    return [];
  }
  const languages = value
    .split(",")
    .map((entry) => normalizeLanguage(entry))
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
  if (languages.length === 0) {
    throw new Error("STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES is empty");
  }
  return languages;
}

function normalizeLanguage(value) {
  const language = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(language)) {
    throw new Error(
      `Invalid STELLA_ANONYMIZE_NATIVE_PACKAGE_LANGUAGES entry: ${value}`,
    );
  }
  return language;
}

function nativeSidecarPackageRoot({ arch, libc, platform }) {
  const packageName = nativeSidecarPackageName({ arch, libc, platform });
  return packageName === null ? null : join(repoRoot, "packages", packageName);
}

function nativeSidecarPackageName({ arch, libc, platform }) {
  if (platform === "darwin" && arch === "arm64") {
    return "anonymize-darwin-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "anonymize-darwin-x64";
  }
  if (platform === "linux" && arch === "arm64" && libc === "gnu") {
    return "anonymize-linux-arm64-gnu";
  }
  if (platform === "linux" && arch === "x64" && libc === "gnu") {
    return "anonymize-linux-x64-gnu";
  }
  if (platform === "win32" && arch === "x64") {
    return "anonymize-win32-x64-msvc";
  }
  return null;
}

function detectNativeLibc(platform) {
  if (platform !== "linux") {
    return undefined;
  }
  return process.report?.getReport?.().header?.glibcVersionRuntime
    ? "gnu"
    : "musl";
}
