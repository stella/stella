import { Result } from "better-result";
import JSZip from "jszip";

import {
  getSkillResourceKind,
  isAllowedResourcePath,
  normalizeResourcePath,
  parseSkillFile,
} from "@stll/skills";
import type { SkillMetadata, SkillResourceKind } from "@stll/skills";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const GITHUB_API_TIMEOUT_MS = 10_000;
const GITHUB_REF_CANDIDATE_LIMIT = 16;
const GITHUB_SKILL_FILE_MAX_BYTES = LIMITS.agentSkillResourceMaxChars * 4;
const GITHUB_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/iu;
const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/iu;
const GITHUB_REPO_PATTERN = /^[a-z0-9._-]{1,100}$/iu;
const GITHUB_DISCOVERY_MAX_SKILLS = 50;
const GITHUB_DISCOVERY_CONCURRENCY = 6;
const GITHUB_TREE_MAX_BYTES = 4 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const GITHUB_SKILL_HOSTNAMES = new Set([
  "github.com",
  "raw.githubusercontent.com",
]);
const GITHUB_FETCH_HEADERS = {
  Accept: "application/vnd.github+json, text/plain, application/zip",
  "User-Agent": "Stella skill importer",
};

export type ParsedSkillResource = {
  content: string;
  kind: PersistedSkillResourceKind;
  path: string;
  sizeBytes: number;
};

export type ParsedSkillPackage = {
  body: string;
  compatibility: string | null;
  contentHash: string;
  description: string;
  license: string | null;
  metadata: Record<string, string>;
  name: string;
  resources: ParsedSkillResource[];
  sourceUrl: string | null;
  version: string | null;
};

export type DiscoveredSkillPackage = {
  compatibility: string | null;
  description: string;
  license: string | null;
  name: string;
  path: string | null;
  sourceUrl: string;
  version: string | null;
};

export type SkillPackageDiscovery = {
  commitSha: string | null;
  invalidSkillCount: number;
  repositoryUrl: string | null;
  skills: DiscoveredSkillPackage[];
};

type PersistedSkillResourceKind = Exclude<SkillResourceKind, "other">;

type SkillFile = {
  content: string;
  path: string;
  sizeBytes: number;
};

type GithubSkillPath = {
  owner: string;
  ref: string;
  repo: string;
  rootPath: string;
};

type GithubRefKind = "heads" | "tags";

type GithubRefExists = (options: {
  owner: string;
  ref: string;
  repo: string;
}) => Promise<boolean>;

type GithubContentItem = {
  path: string;
  size: number | null;
  type: string;
};

export type GithubTreeItem = {
  path: string;
  type: string;
};

const SKILL_RESOURCE_ROOTS = new Set([
  "assets",
  "knowledge",
  "prompts",
  "reference",
  "references",
  "scripts",
  "templates",
]);

export const parseUploadedSkillPackage = async (
  file: File,
): Promise<Result<ParsedSkillPackage, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength > FILE_SIZE_LIMIT_BYTES.skillPack) {
        throw new HandlerError({
          status: 400,
          message: "Skill pack is too large",
        });
      }

      const parsed = isZipFile({ buffer, name: file.name })
        ? await parseZipSkillPackage(buffer)
        : parseMarkdownSkillPackage(decodeUtf8(buffer));
      return { ...parsed, sourceUrl: null };
    },
    catch: toHandlerError,
  });

export const fetchSkillPackageFromUrl = async (
  rawUrl: string,
): Promise<Result<ParsedSkillPackage, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const githubPath = await parseGithubSkillPath(rawUrl);
      if (githubPath) {
        return await fetchGithubSkillPackage(
          githubPath,
          redactSkillSourceUrlForStorage(rawUrl),
        );
      }

      const url = new URL(rawUrl);
      const response = await fetchSafeBytes(url);
      const contentType = response.headers.get("content-type") ?? "";
      const parsed = isZipSkillSource({
        buffer: response.body,
        contentType,
        path: url.pathname,
      })
        ? await parseZipSkillPackage(response.body)
        : parseMarkdownSkillPackage(decodeUtf8(response.body));
      return { ...parsed, sourceUrl: redactSkillSourceUrlForStorage(rawUrl) };
    },
    catch: toHandlerError,
  });

export const discoverSkillPackagesFromUrl = async (
  rawUrl: string,
): Promise<Result<SkillPackageDiscovery, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const githubTarget = await parseGithubDiscoveryPath(rawUrl);
      if (!githubTarget) {
        const parsed = await fetchSkillPackageFromUrl(rawUrl);
        if (Result.isError(parsed)) {
          throw parsed.error;
        }
        return {
          commitSha: null,
          invalidSkillCount: 0,
          repositoryUrl: null,
          skills: [
            toDiscoveredSkill({
              parsed: parsed.value,
              sourceUrl: rawUrl,
            }),
          ],
        };
      }

      return await discoverGithubSkillPackages(githubTarget);
    },
    catch: toHandlerError,
  });

const parseMarkdownSkillPackage = (source: string): ParsedSkillPackage =>
  parseSkillFiles([
    {
      content: source,
      path: SKILL_FILE_NAME,
      sizeBytes: encodedSize(source),
    },
  ]);

const parseZipSkillPackage = async (
  buffer: ArrayBuffer,
): Promise<ParsedSkillPackage> => {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (entries.length > LIMITS.agentSkillArchiveFilesMax) {
    throw new HandlerError({
      status: 400,
      message: "Skill pack has too many files",
    });
  }

  const files: SkillFile[] = [];
  let totalUncompressedBytes = 0;

  for (const file of entries) {
    if (file.dir || file.name.startsWith("__MACOSX/")) {
      continue;
    }
    const normalizedPath = normalizePackageFilePath(file.name);
    if (!normalizedPath) {
      continue;
    }

    const declaredSize = zipUncompressedSize(file);
    if (declaredSize !== null) {
      assertZipUncompressedLimit(totalUncompressedBytes + declaredSize);
    }

    // oxlint-disable-next-line no-await-in-loop -- sequential by design: cumulative-byte limit must abort before decompressing further entries
    const bytes = await file.async("uint8array");
    totalUncompressedBytes += bytes.byteLength;
    assertZipUncompressedLimit(totalUncompressedBytes);

    files.push({
      content: decodeUtf8(bytes),
      path: normalizedPath,
      sizeBytes: bytes.byteLength,
    });
  }

  return parseSkillFiles(files);
};

const assertZipUncompressedLimit = (totalBytes: number) => {
  if (totalBytes <= LIMITS.agentSkillArchiveUncompressedMaxBytes) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: "Skill pack uncompressed content is too large",
  });
};

const parseSkillFiles = (files: readonly SkillFile[]): ParsedSkillPackage => {
  const skillFile = findSkillFile(files);
  const rootPrefix =
    skillFile.path === SKILL_FILE_NAME
      ? ""
      : skillFile.path.slice(0, -SKILL_FILE_NAME.length);
  const relativeSkillSource = skillFile.content;
  const parsed = parseSkillFile(relativeSkillSource);
  const name = parsed.metadata.name;

  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new HandlerError({
      status: 400,
      message:
        "Skill name must use lowercase letters, digits, and hyphens only",
    });
  }
  assertFrontmatterLimits(parsed.metadata);
  if (parsed.body.length > LIMITS.agentSkillBodyMaxChars) {
    throw new HandlerError({
      status: 400,
      message: "Skill instructions are too large",
    });
  }

  const resources = collectResources({ files, rootPrefix });
  return {
    body: parsed.body,
    compatibility: parsed.metadata.compatibility ?? null,
    contentHash: hashSkillPackage({
      resources,
      source: relativeSkillSource,
    }),
    description: parsed.metadata.description,
    license: parsed.metadata.license ?? null,
    metadata: parsed.metadata.metadata ?? {},
    name,
    resources,
    sourceUrl: null,
    version: parsed.metadata.version,
  };
};

const findSkillFile = (files: readonly SkillFile[]): SkillFile => {
  const candidates = files
    .filter(
      (file) =>
        file.path === SKILL_FILE_NAME ||
        file.path.endsWith(`/${SKILL_FILE_NAME}`),
    )
    .toSorted((a, b) => a.path.length - b.path.length);
  const skillFile = candidates.at(0);
  if (!skillFile) {
    throw new HandlerError({
      status: 400,
      message: "Skill pack must include SKILL.md",
    });
  }
  return skillFile;
};

const collectResources = ({
  files,
  rootPrefix,
}: {
  files: readonly SkillFile[];
  rootPrefix: string;
}): ParsedSkillResource[] => {
  const resources: ParsedSkillResource[] = [];

  for (const file of files) {
    if (!file.path.startsWith(rootPrefix)) {
      continue;
    }

    const relativePath = file.path.slice(rootPrefix.length);
    if (relativePath === SKILL_FILE_NAME || relativePath.length === 0) {
      continue;
    }

    const normalizedPath = normalizeResourcePath(relativePath);
    if (!isAllowedResourcePath(normalizedPath)) {
      continue;
    }

    if (file.content.length > LIMITS.agentSkillResourceMaxChars) {
      throw new HandlerError({
        status: 400,
        message: `Skill resource is too large: ${normalizedPath}`,
      });
    }

    const kind = persistedSkillResourceKind(normalizedPath);
    if (!kind) {
      continue;
    }

    resources.push({
      content: file.content,
      kind,
      path: normalizedPath,
      sizeBytes: file.sizeBytes,
    });
  }

  if (resources.length > LIMITS.agentSkillResourcesPerSkill) {
    throw new HandlerError({
      status: 400,
      message: "Skill pack has too many resources",
    });
  }

  // oxlint-disable-next-line require-cached-collator/require-cached-collator -- file path, sorted for deterministic archive layout, not display text
  return resources.toSorted((a, b) => a.path.localeCompare(b.path));
};

const assertFrontmatterLimits = (metadata: SkillMetadata) => {
  assertFrontmatterField({
    field: "description",
    limit: LIMITS.agentSkillDescriptionMaxChars,
    value: metadata.description,
  });
  assertFrontmatterField({
    field: "version",
    limit: LIMITS.agentSkillVersionMaxChars,
    value: metadata.version,
  });
  assertFrontmatterField({
    field: "license",
    limit: LIMITS.agentSkillLicenseMaxChars,
    value: metadata.license,
  });
  assertFrontmatterField({
    field: "compatibility",
    limit: LIMITS.agentSkillCompatibilityMaxChars,
    value: metadata.compatibility,
  });
  assertFrontmatterMetadata(metadata.metadata);
};

const assertFrontmatterField = ({
  field,
  limit,
  value,
}: {
  field: string;
  limit: number;
  value: string | null | undefined;
}) => {
  if (!value || value.length <= limit) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: `Skill ${field} is too large`,
  });
};

const assertFrontmatterMetadata = (
  metadata: Record<string, string> | undefined,
) => {
  const entries = Object.entries(metadata ?? {});
  if (entries.length > LIMITS.agentSkillMetadataEntriesMax) {
    throw new HandlerError({
      status: 400,
      message: "Skill metadata has too many entries",
    });
  }

  for (const [key, value] of entries) {
    if (key.length > LIMITS.agentSkillMetadataKeyMaxChars) {
      throw new HandlerError({
        status: 400,
        message: "Skill metadata key is too large",
      });
    }
    if (value.length > LIMITS.agentSkillMetadataValueMaxChars) {
      throw new HandlerError({
        status: 400,
        message: "Skill metadata value is too large",
      });
    }
  }
};

const persistedSkillResourceKind = (
  path: string,
): PersistedSkillResourceKind | null => {
  const kind = getSkillResourceKind(path);
  switch (kind) {
    case "asset":
    case "knowledge":
    case "prompt":
    case "reference":
    case "script":
    case "template":
      return kind;
    case "other":
    case null:
      return null;
    default:
      return null;
  }
};

const fetchGithubSkillPackage = async (
  target: GithubSkillPath,
  originalUrl: string,
): Promise<ParsedSkillPackage> => {
  const files = await fetchGithubSkillFiles(target);
  const parsed = parseSkillFiles(files);
  return { ...parsed, sourceUrl: originalUrl };
};

const fetchGithubSkillFiles = async (
  target: GithubSkillPath,
): Promise<SkillFile[]> => {
  const files: SkillFile[] = [];
  const pendingDirectories = [target.rootPath];
  const queuedDirectories = new Set(pendingDirectories);
  let totalFileBytes = 0;
  let resourceCount = 0;

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.shift();
    if (directory === undefined) {
      break;
    }

    // oxlint-disable-next-line no-await-in-loop -- breadth-first GitHub traversal: each directory's contents enqueue the next
    const contents = await fetchGithubContents({ target, path: directory });
    for (const item of contents) {
      const relativePath = relativeGithubSkillPath({
        path: item.path,
        rootPath: target.rootPath,
      });
      if (relativePath === null) {
        continue;
      }

      if (item.type === "dir") {
        if (
          shouldTraverseGithubSkillDirectory(relativePath) &&
          !queuedDirectories.has(item.path)
        ) {
          assertGithubDirectoryLimit(queuedDirectories.size + 1);
          queuedDirectories.add(item.path);
          pendingDirectories.push(item.path);
        }
        continue;
      }

      if (item.type !== "file") {
        continue;
      }

      const normalizedPath = normalizePackageFilePath(relativePath);
      if (
        !normalizedPath ||
        (normalizedPath !== SKILL_FILE_NAME &&
          !isAllowedResourcePath(normalizedPath))
      ) {
        continue;
      }

      if (normalizedPath !== SKILL_FILE_NAME) {
        resourceCount += 1;
        assertGithubResourceCount(resourceCount);
      }

      assertGithubDeclaredFileSize({
        path: normalizedPath,
        size: item.size,
      });
      if (item.size !== null) {
        assertGithubTotalFileBytes(totalFileBytes + item.size);
      }

      // oxlint-disable-next-line no-await-in-loop -- sequential by design: cumulative-byte limit must abort before fetching further files; also throttles requests to the GitHub raw content API
      const raw = await fetchSafeBytes(
        githubRawUrl({
          owner: target.owner,
          path: item.path,
          ref: target.ref,
          repo: target.repo,
        }),
        GITHUB_SKILL_FILE_MAX_BYTES,
      );
      totalFileBytes += raw.body.byteLength;
      assertGithubTotalFileBytes(totalFileBytes);

      files.push({
        content: decodeUtf8(raw.body),
        path: normalizedPath,
        sizeBytes: raw.body.byteLength,
      });
    }
  }

  return files;
};

const fetchGithubContents = async ({
  path,
  target,
}: {
  path: string;
  target: GithubSkillPath;
}): Promise<GithubContentItem[]> => {
  const response = await fetchSafeBytes(
    githubContentsUrl({
      owner: target.owner,
      path,
      ref: target.ref,
      repo: target.repo,
    }),
  );
  return parseGithubContentsResponse(JSON.parse(decodeUtf8(response.body)));
};

export const findGithubSkillEntrypoints = ({
  rootPath,
  tree,
}: {
  rootPath: string;
  tree: readonly GithubTreeItem[];
}): string[] => {
  const normalizedRoot = rootPath.replace(/^\/+|\/+$/gu, "");
  const rootPrefix = normalizedRoot ? `${normalizedRoot}/` : "";
  const skillPaths: string[] = [];

  for (const item of tree) {
    if (item.type !== "blob" && item.type !== "file") {
      continue;
    }
    if (rootPrefix && !item.path.startsWith(rootPrefix)) {
      continue;
    }
    const relativePath = rootPrefix
      ? item.path.slice(rootPrefix.length)
      : item.path;
    if (
      relativePath !== SKILL_FILE_NAME &&
      !relativePath.endsWith(`/${SKILL_FILE_NAME}`)
    ) {
      continue;
    }
    skillPaths.push(item.path);
    if (skillPaths.length > GITHUB_DISCOVERY_MAX_SKILLS) {
      throw new HandlerError({
        status: 400,
        message: `A repository or folder may contain at most ${GITHUB_DISCOVERY_MAX_SKILLS} skills`,
      });
    }
  }

  // oxlint-disable-next-line require-cached-collator/require-cached-collator -- repository paths need deterministic code-point ordering, not linguistic collation
  return skillPaths.toSorted((left, right) => left.localeCompare(right));
};

const relativeGithubSkillPath = ({
  path,
  rootPath,
}: {
  path: string;
  rootPath: string;
}): string | null => {
  if (!rootPath) {
    return path;
  }

  if (path === rootPath) {
    return path.split("/").at(-1) ?? path;
  }

  const rootPrefix = `${rootPath}/`;
  return path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : null;
};

const shouldTraverseGithubSkillDirectory = (relativePath: string): boolean => {
  const normalizedPath = normalizePackageFilePath(relativePath);
  if (!normalizedPath || normalizedPath === ".") {
    return false;
  }

  const root = normalizedPath.split("/").at(0);
  return root !== undefined && SKILL_RESOURCE_ROOTS.has(root);
};

const assertGithubDirectoryLimit = (directoryCount: number) => {
  if (directoryCount <= LIMITS.agentSkillGithubDirectoriesMax) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: "Skill has too many GitHub directories",
  });
};

const assertGithubResourceCount = (resourceCount: number) => {
  if (resourceCount <= LIMITS.agentSkillResourcesPerSkill) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: "Skill has too many resources",
  });
};

const assertGithubDeclaredFileSize = ({
  path,
  size,
}: {
  path: string;
  size: number | null;
}) => {
  if (size === null || size <= GITHUB_SKILL_FILE_MAX_BYTES) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: `Skill file is too large: ${path}`,
  });
};

const assertGithubTotalFileBytes = (totalBytes: number) => {
  if (totalBytes <= LIMITS.agentSkillArchiveUncompressedMaxBytes) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: "Skill GitHub content is too large",
  });
};

const githubContentsUrl = ({
  owner,
  path,
  ref,
  repo,
}: {
  owner: string;
  path: string;
  ref: string;
  repo: string;
}) => {
  const encodedPath = path
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join("/");
  const url = new URL(
    encodedPath.length > 0
      ? `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`
      : `https://api.github.com/repos/${owner}/${repo}/contents`,
  );
  url.searchParams.set("ref", ref);
  return url;
};

const githubRawUrl = ({
  owner,
  path,
  ref,
  repo,
}: {
  owner: string;
  path: string;
  ref: string;
  repo: string;
}) =>
  new URL(
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  );

const githubRefUrl = ({
  kind,
  owner,
  ref,
  repo,
}: {
  kind: GithubRefKind;
  owner: string;
  ref: string;
  repo: string;
}) =>
  new URL(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/${kind}/${ref
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  );

const githubRepositoryUrl = ({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) => new URL(`https://api.github.com/repos/${owner}/${repo}`);

const githubCommitUrl = ({
  owner,
  ref,
  repo,
}: {
  owner: string;
  ref: string;
  repo: string;
}) =>
  new URL(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
  );

const githubTreeUrl = ({
  commitSha,
  owner,
  repo,
}: {
  commitSha: string;
  owner: string;
  repo: string;
}) => {
  const url = new URL(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${commitSha}`,
  );
  url.searchParams.set("recursive", "1");
  return url;
};

const pathParts = (url: URL): string[] =>
  url.pathname.split("/").filter((part) => part.length > 0);

const normalizePackageFilePath = (path: string): string | null => {
  try {
    return normalizeResourcePath(path);
  } catch {
    return null;
  }
};

const parseGithubContentsResponse = (value: unknown): GithubContentItem[] => {
  if (Array.isArray(value)) {
    return parseGithubContentItems(value);
  }

  if (isRecord(value)) {
    return parseGithubContentItems([value]);
  }

  throw new HandlerError({
    status: 400,
    message: "GitHub skill contents response is invalid",
  });
};

const parseGithubContentItems = (
  items: readonly unknown[],
): GithubContentItem[] => {
  const parsed: GithubContentItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const path = item["path"];
    const size = item["size"];
    const type = item["type"];
    if (typeof path === "string" && typeof type === "string") {
      parsed.push({
        path,
        size: typeof size === "number" && Number.isFinite(size) ? size : null,
        type,
      });
    }
  }
  return parsed;
};

const hashSkillPackage = ({
  resources,
  source,
}: {
  resources: readonly ParsedSkillResource[];
  source: string;
}) => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(source);
  for (const resource of resources) {
    hasher.update("\0");
    hasher.update(resource.path);
    hasher.update("\0");
    hasher.update(resource.content);
  }
  return hasher.digest("hex");
};

const fetchSafeBytes = async (
  url: URL,
  maxBytes = FILE_SIZE_LIMIT_BYTES.skillPack,
) => {
  const response = await safeOutboundFetchBytes({
    headers: GITHUB_FETCH_HEADERS,
    maxBytes,
    timeoutMs: GITHUB_API_TIMEOUT_MS,
    url,
  });
  if (Result.isError(response)) {
    throw new HandlerError({
      status: 400,
      message: response.error.message,
      cause: response.error,
    });
  }
  if (!response.value.ok) {
    throw new HandlerError({
      status: 400,
      message: `Skill source returned HTTP ${response.value.status}`,
    });
  }
  return response.value;
};

const githubRefExists: GithubRefExists = async ({ owner, ref, repo }) =>
  (await githubRefKindExists({ kind: "heads", owner, ref, repo })) ||
  (await githubRefKindExists({ kind: "tags", owner, ref, repo }));

const githubRefKindExists = async ({
  kind,
  owner,
  ref,
  repo,
}: {
  kind: GithubRefKind;
  owner: string;
  ref: string;
  repo: string;
}): Promise<boolean> => {
  const response = await safeOutboundFetchBytes({
    headers: GITHUB_FETCH_HEADERS,
    maxBytes: FILE_SIZE_LIMIT_BYTES.skillPack,
    timeoutMs: GITHUB_API_TIMEOUT_MS,
    url: githubRefUrl({ kind, owner, ref, repo }),
  });
  if (Result.isError(response)) {
    throw new HandlerError({
      status: 400,
      message: response.error.message,
      cause: response.error,
    });
  }
  if (response.value.status === 404) {
    return false;
  }
  if (!response.value.ok) {
    throw new HandlerError({
      status: 400,
      message: `Skill source returned HTTP ${response.value.status}`,
    });
  }
  return true;
};

export const resolveGithubRefAndPath = async ({
  minPathParts,
  owner,
  parts,
  refExists = githubRefExists,
  repo,
}: {
  minPathParts: number;
  owner: string;
  parts: readonly string[];
  refExists?: GithubRefExists;
  repo: string;
}): Promise<Pick<GithubSkillPath, "ref" | "rootPath"> | null> => {
  const firstRefPartCount = Math.min(
    parts.length - minPathParts,
    GITHUB_REF_CANDIDATE_LIMIT,
  );
  for (
    let refPartCount = firstRefPartCount;
    refPartCount >= 1;
    refPartCount--
  ) {
    const ref = parts.slice(0, refPartCount).join("/");
    if (
      !GITHUB_COMMIT_SHA_PATTERN.test(ref) &&
      // oxlint-disable-next-line no-await-in-loop -- ordered ref-candidate probe: longest match wins, returns on first hit
      !(await refExists({ owner, ref, repo }))
    ) {
      continue;
    }

    const path = parts.slice(refPartCount);
    const rootPath =
      path.at(-1) === SKILL_FILE_NAME
        ? path.slice(0, -1).join("/")
        : path.join("/");
    return { ref, rootPath };
  }

  return null;
};

export const redactSkillSourceUrlForStorage = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.search = "";
  return url.toString();
};

const parseGithubSkillPath = async (
  rawUrl: string,
): Promise<GithubSkillPath | null> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HandlerError({ status: 400, message: "Skill URL is invalid" });
  }

  if (!GITHUB_SKILL_HOSTNAMES.has(url.hostname)) {
    return null;
  }
  assertSafeGithubSkillUrl(url);

  if (url.hostname === "raw.githubusercontent.com") {
    const [owner, rawRepo, ...parts] = pathParts(url);
    const repo = normalizeGithubRepositoryName(rawRepo);
    if (!owner || !repo || parts.length < 2) {
      return null;
    }
    assertGithubRepositoryCoordinates({ owner, repo });
    const resolved = await resolveGithubRefAndPath({
      minPathParts: 1,
      owner,
      parts,
      repo,
    });
    return resolved ? { owner, repo, ...resolved } : null;
  }

  const [owner, rawRepo, kind, ...parts] = pathParts(url);
  const repo = normalizeGithubRepositoryName(rawRepo);
  if (!owner || !repo || !kind || parts.length === 0) {
    return null;
  }
  assertGithubRepositoryCoordinates({ owner, repo });
  if (kind !== "tree" && kind !== "blob") {
    return null;
  }

  const resolved = await resolveGithubRefAndPath({
    minPathParts: kind === "tree" ? 0 : 1,
    owner,
    parts,
    repo,
  });
  return resolved ? { owner, repo, ...resolved } : null;
};

const parseGithubDiscoveryPath = async (
  rawUrl: string,
): Promise<GithubSkillPath | null> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HandlerError({ status: 400, message: "Skill URL is invalid" });
  }

  if (!GITHUB_SKILL_HOSTNAMES.has(url.hostname)) {
    return null;
  }
  assertSafeGithubSkillUrl(url);

  if (url.hostname === "raw.githubusercontent.com") {
    return await parseGithubSkillPath(rawUrl);
  }

  const [owner, rawRepo, kind, ...parts] = pathParts(url);
  const repo = normalizeGithubRepositoryName(rawRepo);
  if (!owner || !repo) {
    throw new HandlerError({
      status: 400,
      message: "GitHub repository URL is invalid",
    });
  }
  assertGithubRepositoryCoordinates({ owner, repo });

  if (!kind) {
    return {
      owner,
      ref: await resolveGithubDefaultBranch({ owner, repo }),
      repo,
      rootPath: "",
    };
  }
  if ((kind !== "tree" && kind !== "blob") || parts.length === 0) {
    throw new HandlerError({
      status: 400,
      message: "Use a GitHub repository, folder, or SKILL.md URL",
    });
  }

  const resolved = await resolveGithubRefAndPath({
    minPathParts: kind === "tree" ? 0 : 1,
    owner,
    parts,
    repo,
  });
  if (!resolved) {
    throw new HandlerError({
      status: 400,
      message: "GitHub branch or folder could not be resolved",
    });
  }
  return { owner, repo, ...resolved };
};

const discoverGithubSkillPackages = async (
  target: GithubSkillPath,
): Promise<SkillPackageDiscovery> => {
  const commitSha = await resolveGithubCommitSha(target);
  const tree = await fetchGithubTree({ ...target, commitSha });
  const skillPaths = findGithubSkillEntrypoints({
    rootPath: target.rootPath,
    tree,
  });
  const entries = await mapWithConcurrency({
    callback: async (skillPath): Promise<DiscoveredSkillPackage | null> => {
      const source = await fetchGithubSkillSource({
        commitSha,
        owner: target.owner,
        path: skillPath,
        repo: target.repo,
      });
      try {
        const parsed = parseMarkdownSkillPackage(source);
        const skillDir =
          skillPath === SKILL_FILE_NAME
            ? ""
            : skillPath.slice(0, -`/${SKILL_FILE_NAME}`.length);
        return toDiscoveredSkill({
          path: skillDir || ".",
          parsed,
          sourceUrl: githubPinnedSkillUrl({
            commitSha,
            owner: target.owner,
            repo: target.repo,
            skillDir,
          }),
        });
      } catch {
        return null;
      }
    },
    items: skillPaths,
    limit: GITHUB_DISCOVERY_CONCURRENCY,
  });
  const skills = entries.filter(
    (entry): entry is DiscoveredSkillPackage => entry !== null,
  );

  return {
    commitSha,
    invalidSkillCount: entries.length - skills.length,
    repositoryUrl: `https://github.com/${target.owner}/${target.repo}`,
    skills,
  };
};

const toDiscoveredSkill = ({
  parsed,
  path = null,
  sourceUrl,
}: {
  parsed: ParsedSkillPackage;
  path?: string | null;
  sourceUrl: string | null;
}): DiscoveredSkillPackage => {
  const resolvedSourceUrl = sourceUrl ?? parsed.sourceUrl;
  if (!resolvedSourceUrl) {
    throw new HandlerError({
      status: 400,
      message: "Skill source URL is missing",
    });
  }

  return {
    compatibility: parsed.compatibility,
    description: parsed.description,
    license: parsed.license,
    name: parsed.name,
    path,
    sourceUrl: resolvedSourceUrl,
    version: parsed.version,
  };
};

const resolveGithubDefaultBranch = async ({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}): Promise<string> => {
  const response = await fetchSafeBytes(githubRepositoryUrl({ owner, repo }));
  const value: unknown = JSON.parse(decodeUtf8(response.body));
  if (
    !isRecord(value) ||
    typeof value["default_branch"] !== "string" ||
    value["default_branch"].trim().length === 0
  ) {
    throw new HandlerError({
      status: 400,
      message: "GitHub repository default branch is unavailable",
    });
  }
  return value["default_branch"].trim();
};

const resolveGithubCommitSha = async (
  target: GithubSkillPath,
): Promise<string> => {
  if (GITHUB_COMMIT_SHA_PATTERN.test(target.ref)) {
    return target.ref.toLowerCase();
  }
  const response = await fetchSafeBytes(
    githubCommitUrl({
      owner: target.owner,
      ref: target.ref,
      repo: target.repo,
    }),
  );
  const value: unknown = JSON.parse(decodeUtf8(response.body));
  const sha = isRecord(value) ? value["sha"] : null;
  if (typeof sha !== "string" || !GITHUB_COMMIT_SHA_PATTERN.test(sha)) {
    throw new HandlerError({
      status: 400,
      message: "GitHub commit could not be resolved",
    });
  }
  return sha.toLowerCase();
};

const fetchGithubTree = async ({
  commitSha,
  owner,
  repo,
}: {
  commitSha: string;
  owner: string;
  repo: string;
}): Promise<GithubTreeItem[]> => {
  const response = await fetchSafeBytes(
    githubTreeUrl({ commitSha, owner, repo }),
    GITHUB_TREE_MAX_BYTES,
  );
  const value: unknown = JSON.parse(decodeUtf8(response.body));
  if (!isRecord(value) || value["truncated"] === true) {
    throw new HandlerError({
      status: 400,
      message: "GitHub repository tree is too large to inspect safely",
    });
  }
  const tree = value["tree"];
  if (!Array.isArray(tree)) {
    throw new HandlerError({
      status: 400,
      message: "GitHub repository tree is invalid",
    });
  }
  const parsed: GithubTreeItem[] = [];
  for (const item of tree) {
    if (!isRecord(item)) {
      continue;
    }
    const path = item["path"];
    const type = item["type"];
    if (typeof path === "string" && typeof type === "string") {
      parsed.push({ path, type });
    }
  }
  return parsed;
};

const fetchGithubSkillSource = async ({
  commitSha,
  owner,
  path,
  repo,
}: {
  commitSha: string;
  owner: string;
  path: string;
  repo: string;
}): Promise<string> => {
  const response = await fetchSafeBytes(
    githubRawUrl({ owner, path, ref: commitSha, repo }),
    GITHUB_SKILL_FILE_MAX_BYTES,
  );
  return decodeUtf8(response.body);
};

const githubPinnedSkillUrl = ({
  commitSha,
  owner,
  repo,
  skillDir,
}: {
  commitSha: string;
  owner: string;
  repo: string;
  skillDir: string;
}) => {
  const path = skillDir
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join("/");
  return `https://github.com/${owner}/${repo}/tree/${commitSha}${path ? `/${path}` : ""}`;
};

const normalizeGithubRepositoryName = (
  value: string | undefined,
): string | null => {
  if (!value) {
    return null;
  }
  return value.endsWith(".git") ? value.slice(0, -4) : value;
};

const assertGithubRepositoryCoordinates = ({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) => {
  if (GITHUB_OWNER_PATTERN.test(owner) && GITHUB_REPO_PATTERN.test(repo)) {
    return;
  }
  throw new HandlerError({
    status: 400,
    message: "GitHub repository URL is invalid",
  });
};

const mapWithConcurrency = async <R>({
  callback,
  items,
  limit,
}: {
  callback: (item: string) => Promise<R>;
  items: readonly string[];
  limit: number;
}): Promise<R[]> => {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items.at(index);
        if (item !== undefined) {
          // oxlint-disable-next-line no-await-in-loop -- each worker claims one bounded queue item at a time
          results[index] = await callback(item);
        }
      }
      return undefined;
    },
  );
  await Promise.all(workers);
  return results;
};

const assertSafeGithubSkillUrl = (url: URL) => {
  if (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.hash
  ) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: "GitHub skill URL is not allowed",
  });
};

export const isZipSkillSource = ({
  buffer,
  contentType,
  path,
}: {
  buffer: ArrayBuffer | Uint8Array;
  contentType: string;
  path: string;
}) => {
  const normalizedContentType = contentType.toLowerCase();
  return (
    normalizedContentType.includes("application/zip") ||
    normalizedContentType.includes("application/x-zip-compressed") ||
    isZipFile({ buffer, name: path })
  );
};

const isZipFile = ({
  buffer,
  name,
}: {
  buffer: ArrayBuffer | Uint8Array;
  name: string;
}) => {
  if (name.toLowerCase().endsWith(".zip")) {
    return true;
  }

  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return (
    bytes.length >= 4 &&
    bytes.at(0) === 0x50 &&
    bytes.at(1) === 0x4b &&
    bytes.at(2) === 0x03 &&
    bytes.at(3) === 0x04
  );
};

const decodeUtf8 = (buffer: ArrayBuffer | Uint8Array): string => {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch (error) {
    throw new HandlerError({
      status: 400,
      message: "Skill files must be UTF-8 text",
      cause: error,
    });
  }
};

const encodedSize = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const zipUncompressedSize = (file: JSZip.JSZipObject): number | null => {
  // JSZip has no public declared-size API; this is only a preflight before the
  // authoritative post-decompression byte count.
  const candidate: unknown = file;
  if (!isRecord(candidate)) {
    return null;
  }

  const metadata = candidate["_data"];
  if (!isRecord(metadata)) {
    return null;
  }

  const size = metadata["uncompressedSize"];
  return typeof size === "number" && Number.isFinite(size) && size >= 0
    ? size
    : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toHandlerError = (cause: unknown): HandlerError =>
  HandlerError.is(cause)
    ? cause
    : new HandlerError({
        status: 400,
        message: "Skill pack could not be imported",
        cause,
      });
