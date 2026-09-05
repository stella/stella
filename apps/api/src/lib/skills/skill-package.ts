import { Result } from "better-result";
import JSZip from "jszip";

import {
  getSkillResourceKind,
  isAllowedResourcePath,
  normalizeResourcePath,
  parseSkillFile,
} from "@stll/skills";
import type { SkillMetadata, SkillResourceKind } from "@stll/skills";
import { SKILL_PACKAGE_LIMITS } from "@stll/skills/package-limits";

import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { isRecord } from "@/api/lib/type-guards";

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const GITHUB_API_TIMEOUT_MS = 10_000;
const GITHUB_DISCOVERY_TIMEOUT_MS = 30_000;
const GITHUB_REF_CANDIDATE_LIMIT = 16;
const GITHUB_SKILL_FILE_MAX_BYTES = LIMITS.agentSkillResourceMaxChars * 4;
const GITHUB_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/iu;
const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/iu;
const GITHUB_REPO_PATTERN = /^[a-z0-9._-]{1,100}$/iu;
const GITHUB_DISCOVERY_MAX_SKILLS = 50;
const GITHUB_DISCOVERY_CONCURRENCY = 6;
const GITHUB_TREE_MAX_BYTES = 4 * 1024 * 1024;
const BIDI_FORMATTING_CONTROL_PATTERN =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const GITHUB_SKILL_HOSTNAMES = new Set([
  "github.com",
  "raw.githubusercontent.com",
]);
const GITHUB_FETCH_HEADERS = {
  Accept: "application/vnd.github+json, text/plain, application/zip",
  "User-Agent": "Stella skill importer",
};
const USER_GITHUB_FETCH_ACCESS = { source: "user" } as const;

export type GithubSkillFetchAccess =
  | { source: "catalogue"; githubToken?: string }
  | { source: "user" };

export const githubSkillFetchHeaders = ({
  access,
  hostname,
}: {
  access: GithubSkillFetchAccess;
  hostname: string;
}): Record<string, string> => ({
  ...GITHUB_FETCH_HEADERS,
  ...(access.source === "catalogue" &&
  access.githubToken &&
  hostname === "api.github.com"
    ? { Authorization: `Bearer ${access.githubToken}` }
    : {}),
});

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
  entrypointHash: string;
  license: string | null;
  metadata: Record<string, string>;
  name: string;
  resources: ParsedSkillResource[];
  sourceUrl: string | null;
  version: string | null;
};

export type SkillSourceIntegrity =
  | { type: "content-hash"; value: string }
  | {
      type: "github-commit";
      entrypointHash: string;
      sourceUrl: string;
      value: string;
    };

export type DiscoveredSkillPackage = {
  compatibility: string | null;
  description: string;
  integrity: SkillSourceIntegrity;
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

export type SkillFile = {
  content: string;
  path: string;
  sizeBytes: number;
};

export type GithubSkillPath = {
  owner: string;
  ref: string;
  repo: string;
  rootPath: string;
  selectedSkillPath: string | null;
};

type GithubRefKind = "heads" | "tags";

type GithubRefExists = (options: {
  owner: string;
  ref: string;
  repo: string;
}) => Promise<boolean>;

export type GithubTreeItem = {
  path: string;
  sha?: string | null;
  size?: number | null;
  type: string;
};

type SkillSourceRequestBudget = {
  deadlineAt: number;
  fetchBytes?: typeof safeOutboundFetchBytes;
  remainingRequests?: number;
  timeoutMessage?: string;
};

export type SkillPackageFetchContext = {
  githubAccess?: GithubSkillFetchAccess;
  requestBudget?: SkillSourceRequestBudget;
  githubTrees: Map<string, Promise<GithubTreeItem[]>>;
};

export const createSkillPackageFetchContext = (
  limits?: {
    deadlineAt: number;
    maxRequests: number;
  },
  fetchBytes: typeof safeOutboundFetchBytes = safeOutboundFetchBytes,
): SkillPackageFetchContext => ({
  ...(limits
    ? {
        requestBudget: {
          deadlineAt: limits.deadlineAt,
          fetchBytes,
          remainingRequests: limits.maxRequests,
          timeoutMessage: "Skill import timed out",
        },
      }
    : {}),
  githubTrees: new Map(),
});

// eslint-disable-next-line promise-function-async -- preserves the cached promise identity so concurrent callers share the same request
export const getOrCreateGithubTreeRequest = ({
  cacheKey,
  context,
  load,
}: {
  cacheKey: string;
  context: SkillPackageFetchContext;
  load: () => Promise<GithubTreeItem[]>;
}): Promise<GithubTreeItem[]> => {
  const cached = context.githubTrees.get(cacheKey);
  if (cached) {
    return cached;
  }
  const request = load();
  context.githubTrees.set(cacheKey, request);
  return request;
};

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
  context = createSkillPackageFetchContext(),
): Promise<Result<ParsedSkillPackage, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const githubPath = await parseGithubSkillPath(
        rawUrl,
        context.requestBudget,
      );
      if (githubPath) {
        return await fetchGithubSkillPackage(
          githubPath,
          redactSkillSourceUrlForStorage(rawUrl),
          context,
        );
      }

      const url = new URL(rawUrl);
      const response = await fetchSafeBytes(
        url,
        FILE_SIZE_LIMIT_BYTES.skillPack,
        context.requestBudget,
      );
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

/**
 * Fetch and parse a catalogue skill from an immutable GitHub directory.
 * This shares the URL importer's tree traversal and resource safeguards so
 * catalogue installs include the pinned SKILL.md and all allowed resources.
 */
export const fetchGithubCatalogueSkillPackage = async ({
  fetchFiles = async (skillTarget) =>
    await fetchGithubSkillFiles(skillTarget, {
      githubAccess: {
        source: "catalogue",
        ...(githubToken ? { githubToken } : {}),
      },
      githubTrees: new Map(),
    }),
  githubToken,
  sourceUrl,
  target,
}: {
  fetchFiles?: (target: GithubSkillPath) => Promise<SkillFile[]>;
  githubToken?: string;
  sourceUrl: string;
  target: GithubSkillPath;
}): Promise<Result<ParsedSkillPackage, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const files = await fetchFiles(target);
      const parsed = parseSkillFiles(files);
      return {
        ...parsed,
        sourceUrl: redactSkillSourceUrlForStorage(sourceUrl),
      };
    },
    catch: toCatalogueHandlerError,
  });

export const discoverSkillPackagesFromUrl = async (
  rawUrl: string,
  fetchBytes: typeof safeOutboundFetchBytes = safeOutboundFetchBytes,
): Promise<Result<SkillPackageDiscovery, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const budget = {
        deadlineAt: Date.now() + GITHUB_DISCOVERY_TIMEOUT_MS,
        fetchBytes,
      };
      const githubTarget = await parseGithubDiscoveryPath(rawUrl, budget);
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
              integrity: {
                type: "content-hash",
                value: parsed.value.contentHash,
              },
              parsed: parsed.value,
              sourceUrl: rawUrl,
            }),
          ],
        };
      }

      return await discoverGithubSkillPackages(githubTarget, budget);
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
    entrypointHash: hashSkillPackage({
      resources: [],
      source: relativeSkillSource,
    }),
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
  const resourcePaths = new Set<string>();

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

    assertSkillResourcePath(normalizedPath);
    if (resourcePaths.has(normalizedPath)) {
      throw new HandlerError({
        status: 400,
        message: `Skill contains a duplicate resource path: ${normalizedPath}`,
      });
    }
    resourcePaths.add(normalizedPath);

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
  assertNoBidiFormattingControls({
    field: "version",
    value: metadata.version,
  });
  assertNoBidiFormattingControls({
    field: "license",
    value: metadata.license,
  });
  assertFrontmatterField({
    field: "compatibility",
    limit: LIMITS.agentSkillCompatibilityMaxChars,
    value: metadata.compatibility,
  });
  assertFrontmatterMetadata(metadata.metadata);
};

const assertNoBidiFormattingControls = ({
  field,
  value,
}: {
  field: string;
  value: string | null | undefined;
}) => {
  if (!value || !BIDI_FORMATTING_CONTROL_PATTERN.test(value)) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: `Skill ${field} contains bidirectional formatting controls`,
  });
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
  context: SkillPackageFetchContext,
): Promise<ParsedSkillPackage> => {
  const files = await fetchGithubSkillFiles(target, context);
  const parsed = parseSkillFiles(files);
  return { ...parsed, sourceUrl: originalUrl };
};

const fetchGithubSkillFiles = async (
  target: GithubSkillPath,
  context: SkillPackageFetchContext,
): Promise<SkillFile[]> => {
  const files: SkillFile[] = [];
  let totalFileBytes = 0;
  let resourceCount = 0;
  const resourcePaths = new Set<string>();
  const commitSha = await resolveGithubCommitSha(target, context.requestBudget);
  const tree = await fetchGithubTreeOnce({
    commitSha,
    context,
    owner: target.owner,
    repo: target.repo,
    rootPath: target.rootPath,
    selectedSkillPath: target.selectedSkillPath,
  });

  for (const item of tree) {
    if (item.type !== "blob" && item.type !== "file") {
      continue;
    }
    const relativePath = relativeGithubSkillPath({
      path: item.path,
      rootPath: target.rootPath,
    });
    if (relativePath === null) {
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
      assertSkillResourcePath(normalizedPath);
      if (resourcePaths.has(normalizedPath)) {
        throw new HandlerError({
          status: 400,
          message: `Skill contains a duplicate resource path: ${normalizedPath}`,
        });
      }
      resourcePaths.add(normalizedPath);
      resourceCount += 1;
      assertGithubResourceCount(resourceCount);
    }

    const declaredSize = item.size ?? null;
    assertGithubDeclaredFileSize({
      path: normalizedPath,
      size: declaredSize,
    });
    if (declaredSize !== null) {
      assertGithubTotalFileBytes(totalFileBytes + declaredSize);
    }

    const raw = await fetchSafeBytes(
      githubRawUrl({
        owner: target.owner,
        path: item.path,
        ref: commitSha,
        repo: target.repo,
      }),
      GITHUB_SKILL_FILE_MAX_BYTES,
      context.requestBudget,
      context.githubAccess,
    );
    totalFileBytes += raw.body.byteLength;
    assertGithubTotalFileBytes(totalFileBytes);

    files.push({
      content: decodeUtf8(raw.body),
      path: normalizedPath,
      sizeBytes: raw.body.byteLength,
    });
  }

  return files;
};

const fetchGithubTreeOnce = async ({
  commitSha,
  context,
  owner,
  repo,
  rootPath,
  selectedSkillPath,
}: {
  commitSha: string;
  context: SkillPackageFetchContext;
  owner: string;
  repo: string;
  rootPath: string;
  selectedSkillPath: string | null;
}): Promise<GithubTreeItem[]> => {
  if (selectedSkillPath !== null) {
    const directoryTree = await fetchGithubScopedTree({
      commitSha,
      context,
      owner,
      recursive: false,
      repo,
      rootPath,
    });
    const resourceRoots = directoryTree.filter((item) => {
      if (item.type !== "tree") {
        return false;
      }
      const relativePath = relativeGithubSkillPath({
        path: item.path,
        rootPath,
      });
      return (
        relativePath !== null &&
        !relativePath.includes("/") &&
        getSkillResourceKind(`${relativePath}/resource.md`) !== null
      );
    });
    const resourceTrees = await mapWithConcurrency({
      items: resourceRoots,
      limit: GITHUB_DISCOVERY_CONCURRENCY,
      transform: async (resourceRoot) => {
        if (!resourceRoot.sha) {
          throw new HandlerError({
            status: 400,
            message: "GitHub skill resource folder could not be resolved",
          });
        }
        return await fetchGithubTreeAtSha({
          context,
          owner,
          pathPrefix: resourceRoot.path,
          recursive: true,
          repo,
          treeish: resourceRoot.sha,
        });
      },
    });
    return [{ path: selectedSkillPath, type: "blob" }, ...resourceTrees.flat()];
  }

  return await fetchGithubScopedTree({
    commitSha,
    context,
    owner,
    recursive: true,
    repo,
    rootPath,
  });
};

const fetchGithubScopedTree = async ({
  commitSha,
  context,
  owner,
  recursive,
  repo,
  rootPath,
}: {
  commitSha: string;
  context: SkillPackageFetchContext;
  owner: string;
  recursive: boolean;
  repo: string;
  rootPath: string;
}): Promise<GithubTreeItem[]> => {
  let treeish = commitSha;
  const pathParts = rootPath.split("/").filter((part) => part.length > 0);
  if (pathParts.length > LIMITS.agentSkillGithubDirectoriesMax) {
    throw new HandlerError({
      status: 400,
      message: "GitHub skill folder is too deeply nested",
    });
  }

  for (const pathPart of pathParts) {
    const level = await fetchGithubTreeRequest({
      context,
      owner,
      recursive: false,
      repo,
      treeish,
    });
    const directory = level.find(
      (item) =>
        item.path === pathPart &&
        item.type === "tree" &&
        typeof item.sha === "string",
    );
    if (!directory?.sha) {
      throw new HandlerError({
        status: 400,
        message: "GitHub skill folder could not be resolved",
      });
    }
    treeish = directory.sha;
  }

  return await fetchGithubTreeAtSha({
    context,
    owner,
    pathPrefix: pathParts.join("/"),
    recursive,
    repo,
    treeish,
  });
};

const fetchGithubTreeAtSha = async ({
  context,
  owner,
  pathPrefix,
  recursive,
  repo,
  treeish,
}: {
  context: SkillPackageFetchContext;
  owner: string;
  pathPrefix: string;
  recursive: boolean;
  repo: string;
  treeish: string;
}): Promise<GithubTreeItem[]> => {
  const tree = await fetchGithubTreeRequest({
    context,
    owner,
    recursive,
    repo,
    treeish,
  });
  if (!pathPrefix) {
    return tree;
  }
  const prefix = `${pathPrefix}/`;
  return tree.map((item) => {
    const scoped: GithubTreeItem = {
      path: `${prefix}${item.path}`,
      type: item.type,
    };
    if (item.sha !== undefined) {
      scoped.sha = item.sha;
    }
    if (item.size !== undefined) {
      scoped.size = item.size;
    }
    return scoped;
  });
};

const fetchGithubTreeRequest = async ({
  context,
  owner,
  recursive,
  repo,
  treeish,
}: {
  context: SkillPackageFetchContext;
  owner: string;
  recursive: boolean;
  repo: string;
  treeish: string;
}): Promise<GithubTreeItem[]> => {
  const cacheKey = `${owner}\0${repo}\0${treeish}\0${recursive ? "recursive" : "direct"}`;
  return await getOrCreateGithubTreeRequest({
    cacheKey,
    context,
    load: async () =>
      await fetchGithubTree({
        ...(context.githubAccess ? { access: context.githubAccess } : {}),
        ...(context.requestBudget ? { budget: context.requestBudget } : {}),
        owner,
        recursive,
        repo,
        treeish,
      }),
  });
};

export const findGithubSkillEntrypoints = ({
  rootPath,
  selectedSkillPath = null,
  tree,
}: {
  rootPath: string;
  selectedSkillPath?: string | null;
  tree: readonly GithubTreeItem[];
}): string[] => {
  if (selectedSkillPath !== null) {
    const selected = tree.find(
      (item) =>
        item.path === selectedSkillPath &&
        (item.type === "blob" || item.type === "file"),
    );
    return selected ? [selected.path] : [];
  }

  const normalizedRoot = rootPath
    .split("/")
    .filter((part) => part.length > 0)
    .join("/");
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

  return skillPaths.toSorted((left, right) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
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
  owner,
  recursive,
  repo,
  treeish,
}: {
  owner: string;
  recursive: boolean;
  repo: string;
  treeish: string;
}) => {
  const url = new URL(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeish}`,
  );
  if (recursive) {
    url.searchParams.set("recursive", "1");
  }
  return url;
};

export const decodeGithubPathParts = (pathname: string): string[] => {
  const parts: string[] = [];
  for (const encodedPart of pathname.split("/")) {
    if (encodedPart.length === 0) {
      continue;
    }
    let part: string;
    try {
      part = decodeURIComponent(encodedPart);
    } catch {
      throw new HandlerError({
        status: 400,
        message: "GitHub URL path encoding is invalid",
      });
    }
    if (part.includes("/") || part.includes("\\")) {
      throw new HandlerError({
        status: 400,
        message: "GitHub URL path is invalid",
      });
    }
    parts.push(part);
  }
  return parts;
};

const pathParts = (url: URL): string[] => decodeGithubPathParts(url.pathname);

const normalizePackageFilePath = (path: string): string | null => {
  try {
    return normalizeResourcePath(path);
  } catch {
    return null;
  }
};

const hashSkillPackage = ({
  resources,
  source,
}: {
  resources: readonly ParsedSkillResource[];
  source: string;
}) => {
  const hasher = new Bun.CryptoHasher("sha256");
  const updateField = (value: string) => {
    const bytes = UTF8_ENCODER.encode(value);
    hasher.update(`${bytes.byteLength}:`);
    hasher.update(bytes);
  };
  updateField("stella-skill-package-v1");
  updateField(source);
  updateField(String(resources.length));
  for (const resource of resources) {
    updateField(resource.path);
    updateField(resource.content);
  }
  return hasher.digest("hex");
};

const fetchSafeBytes = async (
  url: URL,
  maxBytes = FILE_SIZE_LIMIT_BYTES.skillPack,
  budget?: SkillSourceRequestBudget,
  access: GithubSkillFetchAccess = USER_GITHUB_FETCH_ACCESS,
) => {
  consumeSkillSourceRequestBudget(budget);
  const response = await (budget?.fetchBytes ?? safeOutboundFetchBytes)({
    headers: githubSkillFetchHeaders({ access, hostname: url.hostname }),
    maxBytes,
    timeoutMs: githubRequestTimeoutMs(budget),
    url,
  });
  if (Result.isError(response)) {
    throw new HandlerError({
      status: access.source === "catalogue" ? 503 : 400,
      message: response.error.message,
      cause: response.error,
    });
  }
  if (!response.value.ok) {
    throw new HandlerError({
      status:
        access.source === "catalogue"
          ? catalogueUpstreamStatus(response.value.status)
          : 400,
      message: `Skill source returned HTTP ${response.value.status}`,
    });
  }
  return response.value;
};

const consumeSkillSourceRequestBudget = (
  budget: SkillSourceRequestBudget | undefined,
): void => {
  if (budget?.remainingRequests === undefined) {
    return;
  }
  if (budget.remainingRequests <= 0) {
    throw new HandlerError({
      status: 400,
      message: "Skill import exceeded its outbound request limit",
    });
  }
  budget.remainingRequests -= 1;
};

const githubRequestTimeoutMs = (
  budget: SkillSourceRequestBudget | undefined,
): number => {
  if (!budget) {
    return GITHUB_API_TIMEOUT_MS;
  }
  const remainingMs = budget.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new HandlerError({
      status: 400,
      message: budget.timeoutMessage ?? "GitHub skill discovery timed out",
    });
  }
  return Math.min(GITHUB_API_TIMEOUT_MS, remainingMs);
};

const githubRefExists = async (
  { owner, ref, repo }: Parameters<GithubRefExists>[0],
  budget?: SkillSourceRequestBudget,
): Promise<boolean> =>
  (await githubRefKindExists({ budget, kind: "heads", owner, ref, repo })) ||
  (await githubRefKindExists({ budget, kind: "tags", owner, ref, repo }));

const githubRefKindExists = async ({
  budget,
  kind,
  owner,
  ref,
  repo,
}: {
  budget: SkillSourceRequestBudget | undefined;
  kind: GithubRefKind;
  owner: string;
  ref: string;
  repo: string;
}): Promise<boolean> => {
  consumeSkillSourceRequestBudget(budget);
  const response = await (budget?.fetchBytes ?? safeOutboundFetchBytes)({
    headers: GITHUB_FETCH_HEADERS,
    maxBytes: FILE_SIZE_LIMIT_BYTES.skillPack,
    timeoutMs: githubRequestTimeoutMs(budget),
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
}): Promise<Pick<
  GithubSkillPath,
  "ref" | "rootPath" | "selectedSkillPath"
> | null> => {
  // Commit-pinned URLs are unambiguous: the SHA is always one path segment.
  // Resolve it before trying longest-first branch/tag candidates so a nested
  // path does not trigger one GitHub ref probe per ancestor.
  const pinnedCommit = parts[0];
  if (
    pinnedCommit !== undefined &&
    GITHUB_COMMIT_SHA_PATTERN.test(pinnedCommit) &&
    parts.length - 1 >= minPathParts
  ) {
    const path = parts.slice(1);
    return resolvedGithubPath({ path, ref: pinnedCommit });
  }

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
      !(await refExists({ owner, ref, repo }))
    ) {
      continue;
    }

    const path = parts.slice(refPartCount);
    return resolvedGithubPath({ path, ref });
  }

  return null;
};

const resolvedGithubPath = ({
  path,
  ref,
}: {
  path: readonly string[];
  ref: string;
}): Pick<GithubSkillPath, "ref" | "rootPath" | "selectedSkillPath"> => {
  const selectedSkillPath =
    path.at(-1) === SKILL_FILE_NAME ? path.join("/") : null;
  return {
    ref,
    rootPath:
      selectedSkillPath === null ? path.join("/") : path.slice(0, -1).join("/"),
    selectedSkillPath,
  };
};

export const redactSkillSourceUrlForStorage = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  url.search = "";
  return url.toString();
};

const parseGithubSkillPath = async (
  rawUrl: string,
  budget?: SkillSourceRequestBudget,
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
      refExists: async (options) => await githubRefExists(options, budget),
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
    refExists: async (options) => await githubRefExists(options, budget),
    minPathParts: kind === "tree" ? 0 : 1,
    owner,
    parts,
    repo,
  });
  return resolved ? { owner, repo, ...resolved } : null;
};

const parseGithubDiscoveryPath = async (
  rawUrl: string,
  budget: SkillSourceRequestBudget,
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
    return await parseGithubSkillPath(rawUrl, budget);
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
      ref: await resolveGithubDefaultBranch({ budget, owner, repo }),
      repo,
      rootPath: "",
      selectedSkillPath: null,
    };
  }
  if ((kind !== "tree" && kind !== "blob") || parts.length === 0) {
    throw new HandlerError({
      status: 400,
      message: "Use a GitHub repository, folder, or SKILL.md URL",
    });
  }

  const resolved = await resolveGithubRefAndPath({
    refExists: async (options) => await githubRefExists(options, budget),
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
  budget: SkillSourceRequestBudget,
): Promise<SkillPackageDiscovery> => {
  const commitSha = await resolveGithubCommitSha(target, budget);
  const context: SkillPackageFetchContext = {
    githubTrees: new Map(),
    requestBudget: budget,
  };
  const skillPaths =
    target.selectedSkillPath === null
      ? findGithubSkillEntrypoints({
          rootPath: target.rootPath,
          tree: await fetchGithubTreeOnce({
            commitSha,
            context,
            owner: target.owner,
            repo: target.repo,
            rootPath: target.rootPath,
            selectedSkillPath: null,
          }),
        })
      : [target.selectedSkillPath];
  const entries = await mapWithConcurrency({
    transform: async (skillPath): Promise<DiscoveredSkillPackage | null> => {
      const sourceBytes = await fetchGithubSkillSourceBytes({
        budget,
        commitSha,
        owner: target.owner,
        path: skillPath,
        repo: target.repo,
      });
      if (sourceBytes === null) {
        return null;
      }
      try {
        const source = decodeUtf8(sourceBytes);
        const parsed = parseMarkdownSkillPackage(source);
        const skillDir =
          skillPath === SKILL_FILE_NAME
            ? ""
            : skillPath.slice(0, -`/${SKILL_FILE_NAME}`.length);
        const sourceUrl = githubPinnedSkillUrl({
          commitSha,
          owner: target.owner,
          repo: target.repo,
          skillDir,
        });
        return toDiscoveredSkill({
          integrity: {
            type: "github-commit",
            entrypointHash: parsed.entrypointHash,
            sourceUrl,
            value: commitSha,
          },
          path: skillDir || ".",
          parsed,
          sourceUrl,
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
  integrity,
  parsed,
  path = null,
  sourceUrl,
}: {
  integrity: SkillSourceIntegrity;
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
    integrity,
    license: parsed.license,
    name: parsed.name,
    path,
    sourceUrl: resolvedSourceUrl,
    version: parsed.version,
  };
};

export const verifySkillPackageIntegrity = ({
  integrity,
  parsed,
  sourceUrl,
}: {
  integrity: SkillSourceIntegrity;
  parsed: ParsedSkillPackage;
  sourceUrl: string;
}): Result<void, HandlerError> => {
  switch (integrity.type) {
    case "content-hash":
      if (integrity.value === parsed.contentHash) {
        return Result.ok(undefined);
      }
      break;
    case "github-commit": {
      if (integrity.entrypointHash !== parsed.entrypointHash) {
        break;
      }
      const canonicalSourceUrl = canonicalizeGithubCommitSkillUrl({
        commitSha: integrity.value,
        rawUrl: sourceUrl,
      });
      const canonicalIntegritySourceUrl = canonicalizeGithubCommitSkillUrl({
        commitSha: integrity.value,
        rawUrl: integrity.sourceUrl,
      });
      if (
        canonicalSourceUrl !== null &&
        canonicalSourceUrl === canonicalIntegritySourceUrl
      ) {
        return Result.ok(undefined);
      }
      break;
    }
    default:
      return unreachable("Unknown skill source integrity type");
  }

  return Result.err(
    new HandlerError({
      status: 409,
      message: "Skill source changed after discovery; review it again",
    }),
  );
};

export const canonicalizeGithubCommitSkillUrl = ({
  commitSha,
  rawUrl,
}: {
  commitSha: string;
  rawUrl: string;
}): string | null => {
  try {
    const url = new URL(rawUrl.trim());
    assertSafeGithubSkillUrl(url);
    if (
      url.hostname !== "github.com" ||
      url.port.length > 0 ||
      url.search.length > 0
    ) {
      return null;
    }
    const [owner, rawRepo, kind, pinnedCommitSha, ...skillDirParts] =
      pathParts(url);
    const repo = normalizeGithubRepositoryName(rawRepo);
    if (!owner || !repo || !pinnedCommitSha) {
      return null;
    }
    assertGithubRepositoryCoordinates({ owner, repo });
    const normalizedCommitSha = commitSha.toLowerCase();
    if (
      kind !== "tree" ||
      !GITHUB_COMMIT_SHA_PATTERN.test(normalizedCommitSha) ||
      pinnedCommitSha.toLowerCase() !== normalizedCommitSha
    ) {
      return null;
    }
    return githubPinnedSkillUrl({
      commitSha: normalizedCommitSha,
      owner: owner.toLowerCase(),
      repo: repo.toLowerCase(),
      skillDir: skillDirParts.join("/"),
    });
  } catch {
    return null;
  }
};

const resolveGithubDefaultBranch = async ({
  budget,
  owner,
  repo,
}: {
  budget?: SkillSourceRequestBudget;
  owner: string;
  repo: string;
}): Promise<string> => {
  const response = await fetchSafeBytes(
    githubRepositoryUrl({ owner, repo }),
    FILE_SIZE_LIMIT_BYTES.skillPack,
    budget,
  );
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
  budget?: SkillSourceRequestBudget,
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
    FILE_SIZE_LIMIT_BYTES.skillPack,
    budget,
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
  access = USER_GITHUB_FETCH_ACCESS,
  budget,
  owner,
  recursive,
  repo,
  treeish,
}: {
  access?: GithubSkillFetchAccess;
  budget?: SkillSourceRequestBudget;
  owner: string;
  recursive: boolean;
  repo: string;
  treeish: string;
}): Promise<GithubTreeItem[]> => {
  const response = await fetchSafeBytes(
    githubTreeUrl({ owner, recursive, repo, treeish }),
    GITHUB_TREE_MAX_BYTES,
    budget,
    access,
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
    const sha = item["sha"];
    const size = item["size"];
    const type = item["type"];
    if (typeof path === "string" && typeof type === "string") {
      parsed.push({
        path,
        sha: typeof sha === "string" ? sha : null,
        size: typeof size === "number" && Number.isFinite(size) ? size : null,
        type,
      });
    }
  }
  return parsed;
};

const fetchGithubSkillSourceBytes = async ({
  budget,
  commitSha,
  owner,
  path,
  repo,
}: {
  budget?: SkillSourceRequestBudget;
  commitSha: string;
  owner: string;
  path: string;
  repo: string;
}): Promise<ArrayBuffer | null> => {
  consumeSkillSourceRequestBudget(budget);
  const response = await (budget?.fetchBytes ?? safeOutboundFetchBytes)({
    headers: GITHUB_FETCH_HEADERS,
    maxBytes: GITHUB_SKILL_FILE_MAX_BYTES,
    timeoutMs: githubRequestTimeoutMs(budget),
    url: githubRawUrl({ owner, path, ref: commitSha, repo }),
  });
  if (Result.isError(response)) {
    if (response.error.message === "Response body exceeded size limit") {
      return null;
    }
    throw new HandlerError({
      status: 400,
      message: response.error.message,
      cause: response.error,
    });
  }
  if (!response.value.ok) {
    if (response.value.status === 404) {
      return null;
    }
    throw new HandlerError({
      status: 400,
      message: `Skill source returned HTTP ${response.value.status}`,
    });
  }
  return response.value.body;
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
  if (
    GITHUB_OWNER_PATTERN.test(owner) &&
    GITHUB_REPO_PATTERN.test(repo) &&
    repo.split("").some((character) => character !== ".")
  ) {
    return;
  }
  throw new HandlerError({
    status: 400,
    message: "GitHub repository URL is invalid",
  });
};

const mapWithConcurrency = async <T, R>({
  items,
  limit,
  transform,
}: {
  items: readonly T[];
  limit: number;
  transform: (item: T) => Promise<R>;
}): Promise<R[]> => {
  const results: R[] = [];
  const failures: { error: unknown }[] = [];
  let nextIndex = 0;
  const work = async (): Promise<void> => {
    if (failures.length > 0) {
      return;
    }
    const index = nextIndex;
    nextIndex += 1;
    const item = items.at(index);
    if (item === undefined) {
      return;
    }
    try {
      results[index] = await transform(item);
    } catch (error) {
      failures.push({ error });
      return;
    }
    return work();
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, work);
  await Promise.all(workers);
  const failure = failures.at(0);
  if (failure) {
    throw failure.error;
  }
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
  UTF8_ENCODER.encode(value).byteLength;

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

const toHandlerError = (cause: unknown): HandlerError =>
  HandlerError.is(cause)
    ? cause
    : new HandlerError({
        status: 400,
        message: "Skill pack could not be imported",
        cause,
      });

const toCatalogueHandlerError = (cause: unknown): HandlerError => {
  if (
    HandlerError.is(cause) &&
    (cause.status === 502 || cause.status === 503)
  ) {
    return cause;
  }
  return new HandlerError({
    status: 502,
    message: "Catalogue skill package is invalid",
    cause,
  });
};

const catalogueUpstreamStatus = (status: number): 502 | 503 =>
  status === 429 || status >= 500 ? 503 : 502;

const assertSkillResourcePath = (path: string) => {
  if (path.length <= SKILL_PACKAGE_LIMITS.resourcePathMaxChars) {
    return;
  }
  throw new HandlerError({
    status: 400,
    message: `Skill resource path is too long: ${path}`,
  });
};
