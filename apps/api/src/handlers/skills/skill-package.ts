import { Result } from "better-result";
import JSZip from "jszip";

import {
  getSkillResourceKind,
  isAllowedResourcePath,
  normalizeResourcePath,
  parseSkillFile,
} from "@stll/skills";
import type { SkillMetadata, SkillResourceKind } from "@stll/skills";

import { safeMcpFetchBytes } from "@/api/handlers/mcp-connectors/url-safety";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_API_TIMEOUT_MS = 10_000;
const GITHUB_REF_CANDIDATE_LIMIT = 16;
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
        return await fetchGithubSkillPackage(githubPath, rawUrl);
      }

      const url = new URL(rawUrl);
      const response = await fetchSafeBytes(url);
      const contentType = response.headers.get("content-type") ?? "";
      const parsed =
        contentType.includes("application/zip") ||
        rawUrl.toLowerCase().endsWith(".zip")
          ? await parseZipSkillPackage(response.body)
          : parseMarkdownSkillPackage(decodeUtf8(response.body));
      return { ...parsed, sourceUrl: rawUrl };
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

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.shift();
    if (directory === undefined) {
      break;
    }

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

      const raw = await fetchSafeBytes(
        githubRawUrl({
          owner: target.owner,
          path: item.path,
          ref: target.ref,
          repo: target.repo,
        }),
      );
      files.push({
        content: decodeUtf8(raw.body),
        path: normalizedPath,
        sizeBytes: raw.body.byteLength,
      });
      assertGithubResourceLimit(files);
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

const assertGithubResourceLimit = (files: readonly SkillFile[]) => {
  const resourceCount = files.filter(
    (file) => file.path !== SKILL_FILE_NAME,
  ).length;
  if (resourceCount <= LIMITS.agentSkillResourcesPerSkill) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: "Skill has too many resources",
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
    const type = item["type"];
    if (typeof path === "string" && typeof type === "string") {
      parsed.push({ path, type });
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

const fetchSafeBytes = async (url: URL) => {
  const response = await safeMcpFetchBytes({
    headers: GITHUB_FETCH_HEADERS,
    maxBytes: FILE_SIZE_LIMIT_BYTES.skillPack,
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
  const response = await safeMcpFetchBytes({
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
    if (!(await refExists({ owner, ref, repo }))) {
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
    const [owner, repo, ...parts] = pathParts(url);
    if (!owner || !repo || parts.length < 2) {
      return null;
    }
    const resolved = await resolveGithubRefAndPath({
      minPathParts: 1,
      owner,
      parts,
      repo,
    });
    return resolved ? { owner, repo, ...resolved } : null;
  }

  const [owner, repo, kind, ...parts] = pathParts(url);
  if (!owner || !repo || !kind || parts.length === 0) {
    return null;
  }
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

const isZipFile = ({ buffer, name }: { buffer: ArrayBuffer; name: string }) => {
  if (name.toLowerCase().endsWith(".zip")) {
    return true;
  }

  const bytes = new Uint8Array(buffer);
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
