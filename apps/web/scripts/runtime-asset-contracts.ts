import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT_URL = new URL("../", import.meta.url);
const WEB_ROOT_PATH = fileURLToPath(WEB_ROOT_URL);
const SOURCE_ROOT_URL = new URL("src/", WEB_ROOT_URL);
const CLIENT_ROOT_PATH = fileURLToPath(new URL("dist/client/", WEB_ROOT_URL));
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".mjs",
  ".cts",
  ".cjs",
] as const;
const SOURCE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?)$/u;
const DIRECT_WORKER_PATTERN =
  /new\s+(?:Shared)?Worker\s*\(\s*new URL\(\s*["']([^"']+\.(?:[cm]?[jt]sx?))["']\s*,\s*import\.meta\.url\s*\)/gu;
const WORKER_URL_IMPORT_PATTERN =
  /from\s*["']([^"'?]+)\?(?:shared)?worker(?:&(?:inline|url))?["']/gu;
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;

export const SOURCE_WORKER_FILE_GLOB =
  "src/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}";

const toWebRelativePath = (url: URL): string =>
  path.relative(WEB_ROOT_PATH, fileURLToPath(url));

export const workerSourceSpecifiers = (source: string): readonly string[] => {
  const specifiers = new Set<string>();

  for (const pattern of [DIRECT_WORKER_PATTERN, WORKER_URL_IMPORT_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers];
};

const sourceSpecifierUrl = (
  specifier: string,
  sourceUrl: URL,
): URL | undefined => {
  if (specifier.startsWith("@/")) {
    return new URL(specifier.slice(2), SOURCE_ROOT_URL);
  }
  if (specifier.startsWith("/")) {
    return new URL(specifier.slice(1), WEB_ROOT_URL);
  }
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  return new URL(specifier, sourceUrl);
};

export const resolveSourceWorkerEntry = async (
  specifier: string,
  sourceUrl: URL,
): Promise<string | undefined> => {
  const targetUrl = sourceSpecifierUrl(specifier, sourceUrl);
  if (targetUrl === undefined) {
    return undefined;
  }
  if (SOURCE_EXTENSION_PATTERN.test(targetUrl.pathname)) {
    return toWebRelativePath(targetUrl);
  }

  const candidates = await Promise.all(
    SOURCE_EXTENSIONS.map(async (extension) => {
      const candidateUrl = new URL(`${targetUrl.href}${extension}`);
      return {
        candidateUrl,
        exists: await Bun.file(candidateUrl).exists(),
      };
    }),
  );
  const resolvedCandidate = candidates.find(({ exists }) => exists);
  if (resolvedCandidate !== undefined) {
    return toWebRelativePath(resolvedCandidate.candidateUrl);
  }

  // Keep an unresolved local specifier visible to the total registry check.
  return toWebRelativePath(new URL(`${targetUrl.href}.ts`));
};

export const referencedAssetPath = (
  emittedPath: string,
  reference: string,
): string | undefined => {
  const cleanReference = reference.split(/[?#]/u).at(0);
  if (cleanReference === undefined || !/\.(?:js|wasm)$/u.test(cleanReference)) {
    return undefined;
  }
  if (
    URL_SCHEME_PATTERN.test(cleanReference) ||
    cleanReference.startsWith("//")
  ) {
    return undefined;
  }

  const targetUrl = cleanReference.startsWith("/")
    ? new URL(`dist/client${cleanReference}`, WEB_ROOT_URL)
    : new URL(cleanReference, new URL(emittedPath, WEB_ROOT_URL));
  const targetPath = fileURLToPath(targetUrl);
  const relativeToClient = path.relative(CLIENT_ROOT_PATH, targetPath);
  if (relativeToClient.startsWith("..") || path.isAbsolute(relativeToClient)) {
    return undefined;
  }

  return toWebRelativePath(targetUrl);
};
