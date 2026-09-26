import { panic, Result } from "better-result";
import JSZip from "jszip";

import {
  getSkillResourceKind,
  isAllowedResourcePath,
  normalizeResourcePath,
  parseSkillFile,
} from "@stll/skills";
import type { SkillMetadata, SkillResourceKind } from "@stll/skills";
import {
  SKILL_NAME_PATTERN,
  SKILL_PACKAGE_LIMITS,
} from "@stll/skills/package-limits";
import { Temporal } from "@stll/time";

import { hashSkillPackageContent } from "@/api/lib/agent-skills/content-hash";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import type { SafeOutboundFetchResponse } from "@/api/lib/safe-outbound-fetch";
import { isRecord } from "@/api/lib/type-guards";

const SKILL_FILE_NAME = "SKILL.md";
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
  kind: SkillResourceKind;
  path: string;
  sizeBytes: number;
};

export type ParsedSkillPackage = {
  body: string;
  compatibility: string | null;
  description: string;
  entrypointHash: string;
  license: string | null;
  metadata: Record<string, string>;
  name: string;
  resources: ParsedSkillResource[];
  sourceUrl: string | null;
  version: string | null;
};

/** Why an uploaded package file was left out of the installed skill. */
export const SKIPPED_SKILL_FILE_REASON = {
  OUTSIDE_SKILL_FOLDER: "outside-skill-folder",
  UNSUPPORTED_FOLDER: "unsupported-folder",
  UNSUPPORTED_EXTENSION: "unsupported-extension",
  NOT_UTF8_TEXT: "not-utf8-text",
} as const;

type SkippedSkillFileReason =
  (typeof SKIPPED_SKILL_FILE_REASON)[keyof typeof SKIPPED_SKILL_FILE_REASON];

export type SkippedSkillFile = {
  /** The file's path inside the uploaded package. */
  path: string;
  reason: SkippedSkillFileReason;
};

/**
 * An uploaded package as parsed, plus the files it contained that the skill
 * does not keep, so the caller can say what was left out.
 */
export type ImportedSkillPackage = ParsedSkillPackage & {
  skippedFiles: SkippedSkillFile[];
};

/**
 * What makes a repeated URL import the same install. A commit-pinned GitHub
 * source is identified by its pinned URL; any other source by its content, so
 * a mirror serving identical content replays onto the installed skill.
 */
export type UrlReplayIdentity = "content-hash" | "source-url";

/** A package fetched from a URL, carrying how a repeated import replays. */
export type FetchedSkillPackage = ImportedSkillPackage & {
  urlReplayIdentity: UrlReplayIdentity;
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
}) => Promise<Result<boolean, HandlerError>>;

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

type GithubTreeResult = Result<GithubTreeItem[], HandlerError>;

export type SkillPackageFetchContext = {
  githubAccess?: GithubSkillFetchAccess;
  requestBudget?: SkillSourceRequestBudget;
  githubTrees: Map<string, Promise<GithubTreeResult>>;
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

// oxlint-disable-next-line promise-function-async -- preserves the cached promise identity so concurrent callers share the same request
export const getOrCreateGithubTreeRequest = ({
  cacheKey,
  context,
  load,
}: {
  cacheKey: string;
  context: SkillPackageFetchContext;
  load: () => Promise<GithubTreeResult>;
}): Promise<GithubTreeResult> => {
  const cached = context.githubTrees.get(cacheKey);
  if (cached) {
    return cached;
  }
  const request = load();
  context.githubTrees.set(cacheKey, request);
  return request;
};

type SettleSkillPackageOptions<T> = {
  run: () => Promise<Result<T, HandlerError>>;
  toError: (cause: unknown) => HandlerError;
};

/**
 * Answers a rejection and an unexpected exception (a malformed archive, an
 * unparsable GitHub response) through the same `toError`, so an entry point
 * reports both in one shape.
 */
const settleSkillPackage = async <T>({
  run,
  toError,
}: SettleSkillPackageOptions<T>): Promise<Result<T, HandlerError>> => {
  const settled = await Result.tryPromise({ try: run, catch: toError });
  if (settled.isErr()) {
    return Result.err(settled.error);
  }
  return settled.value.mapError(toError);
};

/**
 * Parses an uploaded skill pack. Takes a `ScannedFile`, so every upload path
 * runs the file scan before its bytes reach the parser.
 */
export const parseUploadedSkillPackage = async (
  file: ScannedFile,
): Promise<Result<ImportedSkillPackage, HandlerError>> =>
  await settleSkillPackage({
    run: async () => {
      const buffer = file.bytes;
      if (buffer.byteLength > FILE_SIZE_LIMIT_BYTES.skillPack) {
        return rejectSkillPackage("Skill pack is too large");
      }

      const parsed = isZipFile({ buffer, name: file.fileName })
        ? await parseZipSkillPackage(buffer)
        : parseMarkdownSkillPackageBytes(buffer);
      if (parsed.isErr()) {
        return Result.err(parsed.error);
      }
      return Result.ok({ ...parsed.value, sourceUrl: null });
    },
    toError: toHandlerError,
  });

export const fetchSkillPackageFromUrl = async (
  rawUrl: string,
  context = createSkillPackageFetchContext(),
): Promise<Result<FetchedSkillPackage, HandlerError>> =>
  await settleSkillPackage({
    run: async (): Promise<Result<FetchedSkillPackage, HandlerError>> => {
      const githubPath = await parseGithubSkillPath(
        rawUrl,
        context.requestBudget,
      );
      if (githubPath.isErr()) {
        return Result.err(githubPath.error);
      }
      if (githubPath.value) {
        const parsed = await fetchGithubSkillPackage(
          githubPath.value,
          redactSkillSourceUrlForStorage(rawUrl),
          context,
        );
        if (parsed.isErr()) {
          return Result.err(parsed.error);
        }
        return Result.ok({ ...parsed.value, urlReplayIdentity: "source-url" });
      }

      const url = new URL(rawUrl);
      const response = await fetchSafeBytes(
        url,
        FILE_SIZE_LIMIT_BYTES.skillPack,
        context.requestBudget,
      );
      if (response.isErr()) {
        return Result.err(response.error);
      }
      const { body, headers } = response.value;
      const contentType = headers.get("content-type") ?? "";
      const parsed = isZipSkillSource({
        buffer: body,
        contentType,
        path: url.pathname,
      })
        ? await parseZipSkillPackage(body)
        : parseMarkdownSkillPackageBytes(body);
      if (parsed.isErr()) {
        return Result.err(parsed.error);
      }
      return Result.ok({
        ...parsed.value,
        sourceUrl: redactSkillSourceUrlForStorage(rawUrl),
        urlReplayIdentity: "content-hash",
      });
    },
    toError: toHandlerError,
  });

/**
 * Fetch and parse a catalogue skill from an immutable GitHub directory.
 * This shares the URL importer's tree traversal and resource safeguards so
 * catalogue installs include the pinned SKILL.md and all allowed resources.
 */
export const fetchGithubCatalogueSkillPackage = async ({
  fetchFiles = async (skillTarget) => {
    const fetched = await fetchGithubSkillFiles(skillTarget, {
      githubAccess: {
        source: "catalogue",
        ...(githubToken ? { githubToken } : {}),
      },
      githubTrees: new Map(),
    });
    return fetched.map(({ files }) => files);
  },
  githubToken,
  sourceUrl,
  target,
}: {
  fetchFiles?: (
    target: GithubSkillPath,
  ) => Promise<Result<SkillFile[], HandlerError>>;
  githubToken?: string;
  sourceUrl: string;
  target: GithubSkillPath;
}): Promise<Result<ParsedSkillPackage, HandlerError>> =>
  await settleSkillPackage({
    run: async () => {
      const files = await fetchFiles(target);
      if (files.isErr()) {
        return Result.err(files.error);
      }
      const parsed = parseSkillFiles(files.value);
      if (parsed.isErr()) {
        return Result.err(parsed.error);
      }
      return Result.ok({
        ...parsed.value,
        sourceUrl: redactSkillSourceUrlForStorage(sourceUrl),
      });
    },
    toError: toCatalogueHandlerError,
  });

export const discoverSkillPackagesFromUrl = async (
  rawUrl: string,
  fetchBytes: typeof safeOutboundFetchBytes = safeOutboundFetchBytes,
): Promise<Result<SkillPackageDiscovery, HandlerError>> =>
  await settleSkillPackage({
    run: async (): Promise<Result<SkillPackageDiscovery, HandlerError>> => {
      const budget = {
        deadlineAt:
          Temporal.Now.instant().epochMilliseconds +
          GITHUB_DISCOVERY_TIMEOUT_MS,
        fetchBytes,
      };
      const githubTarget = await parseGithubDiscoveryPath(rawUrl, budget);
      if (githubTarget.isErr()) {
        return Result.err(githubTarget.error);
      }
      if (githubTarget.value) {
        return await discoverGithubSkillPackages(githubTarget.value, budget);
      }

      const parsed = await fetchSkillPackageFromUrl(rawUrl);
      if (parsed.isErr()) {
        return Result.err(parsed.error);
      }
      return Result.ok({
        commitSha: null,
        invalidSkillCount: 0,
        repositoryUrl: null,
        skills: [
          toDiscoveredSkill({
            integrity: {
              type: "content-hash",
              value: hashSkillPackageContent(parsed.value),
            },
            parsed: parsed.value,
            sourceUrl: rawUrl,
          }),
        ],
      });
    },
    toError: toHandlerError,
  });

const parseMarkdownSkillPackage = (
  source: string,
): Result<ParsedSkillPackage, HandlerError> =>
  parseSkillFiles([
    {
      content: source,
      path: SKILL_FILE_NAME,
      sizeBytes: encodedSize(source),
    },
  ]);

const parseMarkdownSkillPackageBytes = (
  buffer: ArrayBuffer | Uint8Array,
): Result<ImportedSkillPackage, HandlerError> => {
  const source = decodeUtf8(buffer);
  if (source.isErr()) {
    return Result.err(source.error);
  }
  const parsed = parseMarkdownSkillPackage(source.value);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  return Result.ok({ ...parsed.value, skippedFiles: [] });
};

type ZipPackageEntry = {
  file: JSZip.JSZipObject;
  path: string;
};

type PackagePathVerdict =
  | { type: "entrypoint" }
  | { type: "resource" }
  | { type: "skipped"; reason: SkippedSkillFileReason };

/**
 * Decides from the path alone whether a package file becomes part of the
 * skill, so files the skill never keeps are not downloaded, inflated or
 * decoded. Zip uploads, zip URLs and GitHub folders all classify through it.
 */
const classifyPackageFilePath = ({
  path,
  rootPrefix,
  skillFilePath,
}: {
  path: string;
  rootPrefix: string;
  skillFilePath: string;
}): PackagePathVerdict => {
  if (path === skillFilePath) {
    return { type: "entrypoint" };
  }
  if (!path.startsWith(rootPrefix)) {
    return {
      type: "skipped",
      reason: SKIPPED_SKILL_FILE_REASON.OUTSIDE_SKILL_FOLDER,
    };
  }
  const relativePath = path.slice(rootPrefix.length);
  if (getSkillResourceKind(relativePath) === null) {
    return {
      type: "skipped",
      reason: SKIPPED_SKILL_FILE_REASON.UNSUPPORTED_FOLDER,
    };
  }
  if (!isAllowedResourcePath(relativePath)) {
    return {
      type: "skipped",
      reason: SKIPPED_SKILL_FILE_REASON.UNSUPPORTED_EXTENSION,
    };
  }
  return { type: "resource" };
};

const parseZipSkillPackage = async (
  buffer: ArrayBuffer,
): Promise<Result<ImportedSkillPackage, HandlerError>> => {
  // oxlint-disable-next-line no-raw-zip-load/no-raw-zip-load -- unbounded archive read predating loadDocxArchive; frozen by the rule budget
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (entries.length > LIMITS.agentSkillArchiveFilesMax) {
    return rejectSkillPackage("Skill pack has too many files");
  }

  const packageEntries: ZipPackageEntry[] = [];
  for (const file of entries) {
    if (file.dir || file.name.startsWith("__MACOSX/")) {
      continue;
    }
    const normalizedPath = normalizePackageFilePath(file.name);
    if (!normalizedPath) {
      continue;
    }
    packageEntries.push({ file, path: normalizedPath });
  }

  const skillFilePath = findSkillFilePath(
    packageEntries.map((entry) => entry.path),
  );
  if (skillFilePath.isErr()) {
    return Result.err(skillFilePath.error);
  }
  const rootPrefix = skillFolderPrefix(skillFilePath.value);
  const files: SkillFile[] = [];
  const skippedFiles: SkippedSkillFile[] = [];
  let totalUncompressedBytes = 0;

  for (const { file, path } of packageEntries) {
    const verdict = classifyPackageFilePath({
      path,
      rootPrefix,
      skillFilePath: skillFilePath.value,
    });
    if (verdict.type === "skipped") {
      skippedFiles.push({ path, reason: verdict.reason });
      continue;
    }

    const declaredSize = zipUncompressedSize(file);
    if (declaredSize !== null) {
      const declaredLimit = checkZipUncompressedLimit(
        totalUncompressedBytes + declaredSize,
      );
      if (declaredLimit.isErr()) {
        return Result.err(declaredLimit.error);
      }
    }

    const bytes = await file.async("uint8array");
    totalUncompressedBytes += bytes.byteLength;
    const inflatedLimit = checkZipUncompressedLimit(totalUncompressedBytes);
    if (inflatedLimit.isErr()) {
      return Result.err(inflatedLimit.error);
    }

    // SKILL.md must be text; a resource that is not (a binary asset) is left
    // out and reported rather than failing the whole package.
    const content = decodePackageFile({ bytes, verdict });
    if (content.isErr()) {
      return Result.err(content.error);
    }
    if (content.value === null) {
      skippedFiles.push({
        path,
        reason: SKIPPED_SKILL_FILE_REASON.NOT_UTF8_TEXT,
      });
      continue;
    }

    files.push({ content: content.value, path, sizeBytes: bytes.byteLength });
  }

  const parsed = parseSkillFiles(files);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  return Result.ok({ ...parsed.value, skippedFiles });
};

type DecodePackageFileOptions = {
  bytes: ArrayBuffer | Uint8Array;
  verdict: Exclude<PackagePathVerdict, { type: "skipped" }>;
};

/**
 * The entry point must decode as UTF-8; a resource that does not answers
 * `null`, so the caller reports it as skipped.
 */
const decodePackageFile = ({
  bytes,
  verdict,
}: DecodePackageFileOptions): Result<string | null, HandlerError> => {
  switch (verdict.type) {
    case "entrypoint":
      return decodeUtf8(bytes);
    case "resource":
      return Result.ok(tryDecodeUtf8(bytes));
    default:
      return unreachable("Unknown package path verdict");
  }
};

const checkZipUncompressedLimit = (
  totalBytes: number,
): Result<void, HandlerError> =>
  totalBytes <= LIMITS.agentSkillArchiveUncompressedMaxBytes
    ? Result.ok()
    : rejectSkillPackage("Skill pack uncompressed content is too large");

const parseSkillFiles = (
  files: readonly SkillFile[],
): Result<ParsedSkillPackage, HandlerError> => {
  const skillFile = findSkillFile(files);
  if (skillFile.isErr()) {
    return Result.err(skillFile.error);
  }
  const rootPrefix = skillFolderPrefix(skillFile.value.path);
  const relativeSkillSource = skillFile.value.content;
  const parsedFile = parseSkillFile(relativeSkillSource);
  if (parsedFile.isErr()) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: parsedFile.error.message,
        cause: parsedFile.error,
      }),
    );
  }
  const parsed = parsedFile.value;
  const name = parsed.metadata.name;

  if (!SKILL_NAME_PATTERN.test(name)) {
    return rejectSkillPackage(
      "Skill name must use lowercase letters and digits, joined by single hyphens",
    );
  }
  const frontmatter = checkFrontmatterLimits(parsed.metadata);
  if (frontmatter.isErr()) {
    return Result.err(frontmatter.error);
  }
  if (parsed.body.length > LIMITS.agentSkillBodyMaxChars) {
    return rejectSkillPackage("Skill instructions are too large");
  }

  const resources = collectResources({ files, rootPrefix });
  if (resources.isErr()) {
    return Result.err(resources.error);
  }
  return Result.ok({
    body: parsed.body,
    compatibility: parsed.metadata.compatibility ?? null,
    description: parsed.metadata.description,
    entrypointHash: hashSkillEntrypoint(relativeSkillSource),
    license: parsed.metadata.license ?? null,
    metadata: parsed.metadata.metadata ?? {},
    name,
    resources: resources.value,
    sourceUrl: null,
    version: parsed.metadata.version,
  });
};

/** The shallowest SKILL.md in the package is its entry point. */
const findSkillFilePath = (
  paths: readonly string[],
): Result<string, HandlerError> => {
  const skillFilePath = paths
    .filter(
      (path) =>
        path === SKILL_FILE_NAME || path.endsWith(`/${SKILL_FILE_NAME}`),
    )
    .toSorted((a, b) => a.length - b.length)
    .at(0);
  return skillFilePath === undefined
    ? rejectSkillPackage("Skill pack must include SKILL.md")
    : Result.ok(skillFilePath);
};

const skillFolderPrefix = (skillFilePath: string): string =>
  skillFilePath.slice(0, -SKILL_FILE_NAME.length);

const findSkillFile = (
  files: readonly SkillFile[],
): Result<SkillFile, HandlerError> => {
  const skillFilePath = findSkillFilePath(files.map((file) => file.path));
  if (skillFilePath.isErr()) {
    return Result.err(skillFilePath.error);
  }
  const skillFile = files.find((file) => file.path === skillFilePath.value);
  if (!skillFile) {
    return panic("The chosen SKILL.md path is one of the package files");
  }
  return Result.ok(skillFile);
};

const collectResources = ({
  files,
  rootPrefix,
}: {
  files: readonly SkillFile[];
  rootPrefix: string;
}): Result<ParsedSkillResource[], HandlerError> => {
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

    const resourcePath = checkSkillResourcePath(normalizedPath);
    if (resourcePath.isErr()) {
      return Result.err(resourcePath.error);
    }
    if (resourcePaths.has(normalizedPath)) {
      return rejectSkillPackage(
        `Skill contains a duplicate resource path: ${normalizedPath}`,
      );
    }
    resourcePaths.add(normalizedPath);

    if (file.content.length > LIMITS.agentSkillResourceMaxChars) {
      return rejectSkillPackage(
        `Skill resource is too large: ${normalizedPath}`,
      );
    }

    const kind = getSkillResourceKind(normalizedPath);
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
    return rejectSkillPackage("Skill pack has too many resources");
  }

  // oxlint-disable-next-line require-cached-collator/require-cached-collator -- file path, sorted for deterministic archive layout, not display text
  return Result.ok(resources.toSorted((a, b) => a.path.localeCompare(b.path)));
};

// Every check is pure, so running them all and answering the first rejection
// reports what checking them in order would.
const checkFrontmatterLimits = (
  metadata: SkillMetadata,
): Result<void, HandlerError> =>
  [
    checkFrontmatterField({
      field: "description",
      limit: LIMITS.agentSkillDescriptionMaxChars,
      value: metadata.description,
    }),
    checkFrontmatterField({
      field: "version",
      limit: LIMITS.agentSkillVersionMaxChars,
      value: metadata.version,
    }),
    checkFrontmatterField({
      field: "license",
      limit: LIMITS.agentSkillLicenseMaxChars,
      value: metadata.license,
    }),
    checkNoBidiFormattingControls({
      field: "version",
      value: metadata.version,
    }),
    checkNoBidiFormattingControls({
      field: "license",
      value: metadata.license,
    }),
    checkFrontmatterField({
      field: "compatibility",
      limit: LIMITS.agentSkillCompatibilityMaxChars,
      value: metadata.compatibility,
    }),
    checkFrontmatterMetadata(metadata.metadata),
  ].find((check) => check.isErr()) ?? Result.ok();

const checkNoBidiFormattingControls = ({
  field,
  value,
}: {
  field: string;
  value: string | null | undefined;
}): Result<void, HandlerError> =>
  !value || !BIDI_FORMATTING_CONTROL_PATTERN.test(value)
    ? Result.ok()
    : rejectSkillPackage(
        `Skill ${field} contains bidirectional formatting controls`,
      );

const checkFrontmatterField = ({
  field,
  limit,
  value,
}: {
  field: string;
  limit: number;
  value: string | null | undefined;
}): Result<void, HandlerError> =>
  !value || value.length <= limit
    ? Result.ok()
    : rejectSkillPackage(`Skill ${field} is too large`);

const checkFrontmatterMetadata = (
  metadata: Record<string, string> | undefined,
): Result<void, HandlerError> => {
  const entries = Object.entries(metadata ?? {});
  if (entries.length > LIMITS.agentSkillMetadataEntriesMax) {
    return rejectSkillPackage("Skill metadata has too many entries");
  }

  for (const [key, value] of entries) {
    if (key.length > LIMITS.agentSkillMetadataKeyMaxChars) {
      return rejectSkillPackage("Skill metadata key is too large");
    }
    if (value.length > LIMITS.agentSkillMetadataValueMaxChars) {
      return rejectSkillPackage("Skill metadata value is too large");
    }
  }
  return Result.ok();
};

const fetchGithubSkillPackage = async (
  target: GithubSkillPath,
  originalUrl: string,
  context: SkillPackageFetchContext,
): Promise<Result<ImportedSkillPackage, HandlerError>> => {
  const fetched = await fetchGithubSkillFiles(target, context);
  if (fetched.isErr()) {
    return Result.err(fetched.error);
  }
  const { files, skippedFiles } = fetched.value;
  const parsed = parseSkillFiles(files);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  return Result.ok({ ...parsed.value, skippedFiles, sourceUrl: originalUrl });
};

type GithubSkillFiles = {
  files: SkillFile[];
  skippedFiles: SkippedSkillFile[];
};

const fetchGithubSkillFiles = async (
  target: GithubSkillPath,
  context: SkillPackageFetchContext,
): Promise<Result<GithubSkillFiles, HandlerError>> => {
  const files: SkillFile[] = [];
  const skippedFiles: SkippedSkillFile[] = [];
  let totalFileBytes = 0;
  let resourceCount = 0;
  const resourcePaths = new Set<string>();
  const commitSha = await resolveGithubCommitSha(target, context.requestBudget);
  if (commitSha.isErr()) {
    return Result.err(commitSha.error);
  }
  const tree = await fetchGithubTreeOnce({
    commitSha: commitSha.value,
    context,
    owner: target.owner,
    repo: target.repo,
    rootPath: target.rootPath,
    selectedSkillPath: target.selectedSkillPath,
  });
  if (tree.isErr()) {
    return Result.err(tree.error);
  }

  for (const item of tree.value) {
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
    if (!normalizedPath) {
      continue;
    }
    const verdict = classifyPackageFilePath({
      path: normalizedPath,
      rootPrefix: "",
      skillFilePath: SKILL_FILE_NAME,
    });
    if (verdict.type === "skipped") {
      skippedFiles.push({ path: normalizedPath, reason: verdict.reason });
      continue;
    }

    if (normalizedPath !== SKILL_FILE_NAME) {
      const resourcePath = checkSkillResourcePath(normalizedPath);
      if (resourcePath.isErr()) {
        return Result.err(resourcePath.error);
      }
      if (resourcePaths.has(normalizedPath)) {
        return rejectSkillPackage(
          `Skill contains a duplicate resource path: ${normalizedPath}`,
        );
      }
      resourcePaths.add(normalizedPath);
      resourceCount += 1;
      if (resourceCount > LIMITS.agentSkillResourcesPerSkill) {
        return rejectSkillPackage("Skill has too many resources");
      }
    }

    const declaredSize = item.size ?? null;
    if (declaredSize !== null) {
      if (declaredSize > GITHUB_SKILL_FILE_MAX_BYTES) {
        return rejectSkillPackage(`Skill file is too large: ${normalizedPath}`);
      }
      const declaredTotal = checkGithubTotalFileBytes(
        totalFileBytes + declaredSize,
      );
      if (declaredTotal.isErr()) {
        return Result.err(declaredTotal.error);
      }
    }

    const raw = await fetchSafeBytes(
      githubRawUrl({
        owner: target.owner,
        path: item.path,
        ref: commitSha.value,
        repo: target.repo,
      }),
      GITHUB_SKILL_FILE_MAX_BYTES,
      context.requestBudget,
      context.githubAccess,
    );
    if (raw.isErr()) {
      return Result.err(raw.error);
    }
    const { body } = raw.value;
    totalFileBytes += body.byteLength;
    const fetchedTotal = checkGithubTotalFileBytes(totalFileBytes);
    if (fetchedTotal.isErr()) {
      return Result.err(fetchedTotal.error);
    }

    // SKILL.md must be text; a resource that is not is left out and
    // reported, as a zip upload does.
    const content = decodePackageFile({ bytes: body, verdict });
    if (content.isErr()) {
      return Result.err(content.error);
    }
    if (content.value === null) {
      skippedFiles.push({
        path: normalizedPath,
        reason: SKIPPED_SKILL_FILE_REASON.NOT_UTF8_TEXT,
      });
      continue;
    }
    files.push({
      content: content.value,
      path: normalizedPath,
      sizeBytes: body.byteLength,
    });
  }

  return Result.ok({ files, skippedFiles });
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
}): Promise<GithubTreeResult> => {
  if (selectedSkillPath !== null) {
    const scopedTree = await fetchGithubScopedTree({
      commitSha,
      context,
      owner,
      recursive: false,
      repo,
      rootPath,
    });
    if (scopedTree.isErr()) {
      return Result.err(scopedTree.error);
    }
    const directoryTree = scopedTree.value;
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
          return rejectSkillPackage(
            "GitHub skill resource folder could not be resolved",
          );
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
    if (resourceTrees.isErr()) {
      return Result.err(resourceTrees.error);
    }
    // Files beside SKILL.md are listed so the import can report them; the
    // folders that hold no resources are never listed.
    const siblingFiles = directoryTree.filter(
      (item) =>
        (item.type === "blob" || item.type === "file") &&
        item.path !== selectedSkillPath,
    );
    return Result.ok([
      { path: selectedSkillPath, type: "blob" },
      ...siblingFiles,
      ...resourceTrees.value.flat(),
    ]);
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
}): Promise<GithubTreeResult> => {
  let treeish = commitSha;
  const pathParts = rootPath.split("/").filter((part) => part.length > 0);
  if (pathParts.length > LIMITS.agentSkillGithubDirectoriesMax) {
    return rejectSkillPackage("GitHub skill folder is too deeply nested");
  }

  for (const pathPart of pathParts) {
    const level = await fetchGithubTreeRequest({
      context,
      owner,
      recursive: false,
      repo,
      treeish,
    });
    if (level.isErr()) {
      return level;
    }
    const directory = level.value.find(
      (item) =>
        item.path === pathPart &&
        item.type === "tree" &&
        typeof item.sha === "string",
    );
    if (!directory?.sha) {
      return rejectSkillPackage("GitHub skill folder could not be resolved");
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
}): Promise<GithubTreeResult> => {
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
  return tree.map((items) =>
    items.map((item) => {
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
    }),
  );
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
}): Promise<GithubTreeResult> => {
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
}): Result<string[], HandlerError> => {
  if (selectedSkillPath !== null) {
    const selected = tree.find(
      (item) =>
        item.path === selectedSkillPath &&
        (item.type === "blob" || item.type === "file"),
    );
    return Result.ok(selected ? [selected.path] : []);
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
      return rejectSkillPackage(
        `A repository or folder may contain at most ${GITHUB_DISCOVERY_MAX_SKILLS} skills`,
      );
    }
  }

  return Result.ok(
    skillPaths.toSorted((left, right) => {
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    }),
  );
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

const checkGithubTotalFileBytes = (
  totalBytes: number,
): Result<void, HandlerError> =>
  totalBytes <= LIMITS.agentSkillArchiveUncompressedMaxBytes
    ? Result.ok()
    : rejectSkillPackage("Skill GitHub content is too large");

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

export const decodeGithubPathParts = (
  pathname: string,
): Result<string[], HandlerError> => {
  const parts: string[] = [];
  for (const encodedPart of pathname.split("/")) {
    if (encodedPart.length === 0) {
      continue;
    }
    const part = Result.try(() => decodeURIComponent(encodedPart));
    if (part.isErr()) {
      return rejectSkillPackage("GitHub URL path encoding is invalid");
    }
    if (part.value.includes("/") || part.value.includes("\\")) {
      return rejectSkillPackage("GitHub URL path is invalid");
    }
    parts.push(part.value);
  }
  return Result.ok(parts);
};

const pathParts = (url: URL): Result<string[], HandlerError> =>
  decodeGithubPathParts(url.pathname);

// `normalizeResourcePath` panics on a path that escapes the skill folder; such
// a package file is ignored rather than failing the import.
const normalizePackageFilePath = (path: string): string | null =>
  Result.try(() => normalizeResourcePath(path)).unwrapOr(null);

// Identifies the SKILL.md a GitHub preview showed, independent of resources.
const hashSkillEntrypoint = (source: string) => {
  const hasher = new Bun.CryptoHasher("sha256");
  const updateField = (value: string) => {
    const bytes = UTF8_ENCODER.encode(value);
    hasher.update(`${bytes.byteLength}:`);
    hasher.update(bytes);
  };
  updateField("stella-skill-package-v1");
  updateField(source);
  updateField("0");
  return hasher.digest("hex");
};

const fetchSafeBytes = async (
  url: URL,
  maxBytes = FILE_SIZE_LIMIT_BYTES.skillPack,
  budget?: SkillSourceRequestBudget,
  access: GithubSkillFetchAccess = USER_GITHUB_FETCH_ACCESS,
): Promise<Result<SafeOutboundFetchResponse, HandlerError>> => {
  const timeoutMs = startSkillSourceRequest(budget);
  if (timeoutMs.isErr()) {
    return Result.err(timeoutMs.error);
  }
  const response = await (budget?.fetchBytes ?? safeOutboundFetchBytes)({
    headers: githubSkillFetchHeaders({ access, hostname: url.hostname }),
    maxBytes,
    timeoutMs: timeoutMs.value,
    url,
  });
  if (Result.isError(response)) {
    return Result.err(
      new HandlerError({
        status: access.source === "catalogue" ? 503 : 400,
        message: response.error.message,
        cause: response.error,
      }),
    );
  }
  if (!response.value.ok) {
    return Result.err(
      new HandlerError({
        status:
          access.source === "catalogue"
            ? catalogueUpstreamStatus(response.value.status)
            : 400,
        message: `Skill source returned HTTP ${response.value.status}`,
      }),
    );
  }
  return Result.ok(response.value);
};

/**
 * Spends one outbound request from the budget and answers the timeout that
 * request may take.
 */
const startSkillSourceRequest = (
  budget: SkillSourceRequestBudget | undefined,
): Result<number, HandlerError> => {
  if (budget === undefined) {
    return Result.ok(GITHUB_API_TIMEOUT_MS);
  }
  if (budget.remainingRequests !== undefined) {
    if (budget.remainingRequests <= 0) {
      return rejectSkillPackage(
        "Skill import exceeded its outbound request limit",
      );
    }
    budget.remainingRequests -= 1;
  }
  const remainingMs =
    budget.deadlineAt - Temporal.Now.instant().epochMilliseconds;
  if (remainingMs <= 0) {
    return rejectSkillPackage(
      budget.timeoutMessage ?? "GitHub skill discovery timed out",
    );
  }
  return Result.ok(Math.min(GITHUB_API_TIMEOUT_MS, remainingMs));
};

const githubRefExists = async (
  { owner, ref, repo }: Parameters<GithubRefExists>[0],
  budget?: SkillSourceRequestBudget,
): Promise<Result<boolean, HandlerError>> => {
  const heads = await githubRefKindExists({
    budget,
    kind: "heads",
    owner,
    ref,
    repo,
  });
  if (heads.isErr() || heads.value) {
    return heads;
  }
  return await githubRefKindExists({ budget, kind: "tags", owner, ref, repo });
};

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
}): Promise<Result<boolean, HandlerError>> => {
  const timeoutMs = startSkillSourceRequest(budget);
  if (timeoutMs.isErr()) {
    return Result.err(timeoutMs.error);
  }
  const response = await (budget?.fetchBytes ?? safeOutboundFetchBytes)({
    headers: GITHUB_FETCH_HEADERS,
    maxBytes: FILE_SIZE_LIMIT_BYTES.skillPack,
    timeoutMs: timeoutMs.value,
    url: githubRefUrl({ kind, owner, ref, repo }),
  });
  if (Result.isError(response)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: response.error.message,
        cause: response.error,
      }),
    );
  }
  if (response.value.status === 404) {
    return Result.ok(false);
  }
  if (!response.value.ok) {
    return rejectSkillPackage(
      `Skill source returned HTTP ${response.value.status}`,
    );
  }
  return Result.ok(true);
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
}): Promise<Result<ResolvedGithubPath | null, HandlerError>> => {
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
    return Result.ok(resolvedGithubPath({ path, ref: pinnedCommit }));
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
    if (!GITHUB_COMMIT_SHA_PATTERN.test(ref)) {
      const exists = await refExists({ owner, ref, repo });
      if (exists.isErr()) {
        return Result.err(exists.error);
      }
      if (!exists.value) {
        continue;
      }
    }

    const path = parts.slice(refPartCount);
    return Result.ok(resolvedGithubPath({ path, ref }));
  }

  return Result.ok(null);
};

type ResolvedGithubPath = Pick<
  GithubSkillPath,
  "ref" | "rootPath" | "selectedSkillPath"
>;

const resolvedGithubPath = ({
  path,
  ref,
}: {
  path: readonly string[];
  ref: string;
}): ResolvedGithubPath => {
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

/**
 * A GitHub skill URL on an allowed host, split into its decoded path segments;
 * `null` for a URL on any other host.
 */
const parseGithubSkillUrl = (
  rawUrl: string,
): Result<{ parts: string[]; url: URL } | null, HandlerError> => {
  const url = URL.parse(rawUrl);
  if (url === null) {
    return rejectSkillPackage("Skill URL is invalid");
  }
  if (!GITHUB_SKILL_HOSTNAMES.has(url.hostname)) {
    return Result.ok(null);
  }
  const safe = checkSafeGithubSkillUrl(url);
  if (safe.isErr()) {
    return Result.err(safe.error);
  }
  return pathParts(url).map((parts) => ({ parts, url }));
};

const parseGithubSkillPath = async (
  rawUrl: string,
  budget?: SkillSourceRequestBudget,
): Promise<Result<GithubSkillPath | null, HandlerError>> => {
  const githubUrl = parseGithubSkillUrl(rawUrl);
  if (githubUrl.isErr() || githubUrl.value === null) {
    return githubUrl.map(() => null);
  }
  const { parts: urlParts, url } = githubUrl.value;

  if (url.hostname === "raw.githubusercontent.com") {
    const [owner, rawRepo, ...parts] = urlParts;
    const repo = normalizeGithubRepositoryName(rawRepo);
    if (!owner || !repo || parts.length < 2) {
      return Result.ok(null);
    }
    const coordinates = checkGithubRepositoryCoordinates({ owner, repo });
    if (coordinates.isErr()) {
      return Result.err(coordinates.error);
    }
    const resolved = await resolveGithubRefAndPath({
      refExists: async (options) => await githubRefExists(options, budget),
      minPathParts: 1,
      owner,
      parts,
      repo,
    });
    if (resolved.isErr()) {
      return Result.err(resolved.error);
    }
    return Result.ok(
      resolved.value ? { owner, repo, ...resolved.value } : null,
    );
  }

  const [owner, rawRepo, kind, ...parts] = urlParts;
  const repo = normalizeGithubRepositoryName(rawRepo);
  if (!owner || !repo || !kind || parts.length === 0) {
    return Result.ok(null);
  }
  const coordinates = checkGithubRepositoryCoordinates({ owner, repo });
  if (coordinates.isErr()) {
    return Result.err(coordinates.error);
  }
  if (kind !== "tree" && kind !== "blob") {
    return Result.ok(null);
  }

  const resolved = await resolveGithubRefAndPath({
    refExists: async (options) => await githubRefExists(options, budget),
    minPathParts: kind === "tree" ? 0 : 1,
    owner,
    parts,
    repo,
  });
  if (resolved.isErr()) {
    return Result.err(resolved.error);
  }
  return Result.ok(resolved.value ? { owner, repo, ...resolved.value } : null);
};

const parseGithubDiscoveryPath = async (
  rawUrl: string,
  budget: SkillSourceRequestBudget,
): Promise<Result<GithubSkillPath | null, HandlerError>> => {
  const githubUrl = parseGithubSkillUrl(rawUrl);
  if (githubUrl.isErr() || githubUrl.value === null) {
    return githubUrl.map(() => null);
  }
  const { parts: urlParts, url } = githubUrl.value;

  if (url.hostname === "raw.githubusercontent.com") {
    return await parseGithubSkillPath(rawUrl, budget);
  }

  const [owner, rawRepo, kind, ...parts] = urlParts;
  const repo = normalizeGithubRepositoryName(rawRepo);
  if (!owner || !repo) {
    return rejectSkillPackage("GitHub repository URL is invalid");
  }
  const coordinates = checkGithubRepositoryCoordinates({ owner, repo });
  if (coordinates.isErr()) {
    return Result.err(coordinates.error);
  }

  if (!kind) {
    const ref = await resolveGithubDefaultBranch({ budget, owner, repo });
    return ref.map((defaultBranch) => ({
      owner,
      ref: defaultBranch,
      repo,
      rootPath: "",
      selectedSkillPath: null,
    }));
  }
  if ((kind !== "tree" && kind !== "blob") || parts.length === 0) {
    return rejectSkillPackage(
      "Use a GitHub repository, folder, or SKILL.md URL",
    );
  }

  const resolved = await resolveGithubRefAndPath({
    refExists: async (options) => await githubRefExists(options, budget),
    minPathParts: kind === "tree" ? 0 : 1,
    owner,
    parts,
    repo,
  });
  if (resolved.isErr()) {
    return Result.err(resolved.error);
  }
  if (!resolved.value) {
    return rejectSkillPackage("GitHub branch or folder could not be resolved");
  }
  return Result.ok({ owner, repo, ...resolved.value });
};

const discoverGithubSkillPackages = async (
  target: GithubSkillPath,
  budget: SkillSourceRequestBudget,
): Promise<Result<SkillPackageDiscovery, HandlerError>> => {
  const resolvedCommitSha = await resolveGithubCommitSha(target, budget);
  if (resolvedCommitSha.isErr()) {
    return Result.err(resolvedCommitSha.error);
  }
  const commitSha = resolvedCommitSha.value;
  const skillPaths = await findDiscoverableSkillPaths({
    budget,
    commitSha,
    target,
  });
  if (skillPaths.isErr()) {
    return Result.err(skillPaths.error);
  }
  const entries = await mapWithConcurrency({
    transform: async (
      skillPath,
    ): Promise<Result<DiscoveredSkillPackage | null, HandlerError>> => {
      const sourceBytes = await fetchGithubSkillSourceBytes({
        budget,
        commitSha,
        owner: target.owner,
        path: skillPath,
        repo: target.repo,
      });
      if (sourceBytes.isErr() || sourceBytes.value === null) {
        return sourceBytes.map(() => null);
      }
      const bytes = sourceBytes.value;
      // A skill that does not parse, for any reason, is counted as invalid
      // rather than failing the whole discovery.
      const discovered = Result.try(() =>
        toDiscoveredGithubSkill({
          commitSha,
          skillPath,
          sourceBytes: bytes,
          target,
        }),
      );
      return Result.ok(Result.flatten(discovered).unwrapOr(null));
    },
    items: skillPaths.value,
    limit: GITHUB_DISCOVERY_CONCURRENCY,
  });
  if (entries.isErr()) {
    return Result.err(entries.error);
  }
  const skills = entries.value.filter(
    (entry): entry is DiscoveredSkillPackage => entry !== null,
  );

  return Result.ok({
    commitSha,
    invalidSkillCount: entries.value.length - skills.length,
    repositoryUrl: `https://github.com/${target.owner}/${target.repo}`,
    skills,
  });
};

type FindDiscoverableSkillPathsOptions = {
  budget: SkillSourceRequestBudget;
  commitSha: string;
  target: GithubSkillPath;
};

const findDiscoverableSkillPaths = async ({
  budget,
  commitSha,
  target,
}: FindDiscoverableSkillPathsOptions): Promise<
  Result<string[], HandlerError>
> => {
  if (target.selectedSkillPath !== null) {
    return Result.ok([target.selectedSkillPath]);
  }
  const tree = await fetchGithubTreeOnce({
    commitSha,
    context: { githubTrees: new Map(), requestBudget: budget },
    owner: target.owner,
    repo: target.repo,
    rootPath: target.rootPath,
    selectedSkillPath: null,
  });
  if (tree.isErr()) {
    return Result.err(tree.error);
  }
  return findGithubSkillEntrypoints({
    rootPath: target.rootPath,
    tree: tree.value,
  });
};

type ToDiscoveredGithubSkillOptions = {
  commitSha: string;
  skillPath: string;
  sourceBytes: ArrayBuffer;
  target: GithubSkillPath;
};

const toDiscoveredGithubSkill = ({
  commitSha,
  skillPath,
  sourceBytes,
  target,
}: ToDiscoveredGithubSkillOptions): Result<
  DiscoveredSkillPackage,
  HandlerError
> => {
  const source = decodeUtf8(sourceBytes);
  if (source.isErr()) {
    return Result.err(source.error);
  }
  const parsed = parseMarkdownSkillPackage(source.value);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
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
  return Result.ok(
    toDiscoveredSkill({
      integrity: {
        type: "github-commit",
        entrypointHash: parsed.value.entrypointHash,
        sourceUrl,
        value: commitSha,
      },
      path: skillDir || ".",
      parsed: parsed.value,
      sourceUrl,
    }),
  );
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
  sourceUrl: string;
}): DiscoveredSkillPackage => ({
  compatibility: parsed.compatibility,
  description: parsed.description,
  integrity,
  license: parsed.license,
  name: parsed.name,
  path,
  sourceUrl,
  version: parsed.version,
});

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
      if (integrity.value === hashSkillPackageContent(parsed)) {
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
  const url = URL.parse(rawUrl.trim());
  if (
    url === null ||
    checkSafeGithubSkillUrl(url).isErr() ||
    url.hostname !== "github.com" ||
    url.port.length > 0 ||
    url.search.length > 0
  ) {
    return null;
  }
  const parts = pathParts(url);
  if (parts.isErr()) {
    return null;
  }
  const [owner, rawRepo, kind, pinnedCommitSha, ...skillDirParts] = parts.value;
  const repo = normalizeGithubRepositoryName(rawRepo);
  if (
    !owner ||
    !repo ||
    !pinnedCommitSha ||
    checkGithubRepositoryCoordinates({ owner, repo }).isErr()
  ) {
    return null;
  }
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
};

const resolveGithubDefaultBranch = async ({
  budget,
  owner,
  repo,
}: {
  budget?: SkillSourceRequestBudget;
  owner: string;
  repo: string;
}): Promise<Result<string, HandlerError>> => {
  const response = await fetchSafeBytes(
    githubRepositoryUrl({ owner, repo }),
    FILE_SIZE_LIMIT_BYTES.skillPack,
    budget,
  );
  if (response.isErr()) {
    return Result.err(response.error);
  }
  const body = decodeUtf8(response.value.body);
  if (body.isErr()) {
    return Result.err(body.error);
  }
  const value: unknown = JSON.parse(body.value);
  if (
    !isRecord(value) ||
    typeof value["default_branch"] !== "string" ||
    value["default_branch"].trim().length === 0
  ) {
    return rejectSkillPackage(
      "GitHub repository default branch is unavailable",
    );
  }
  return Result.ok(value["default_branch"].trim());
};

const resolveGithubCommitSha = async (
  target: GithubSkillPath,
  budget?: SkillSourceRequestBudget,
): Promise<Result<string, HandlerError>> => {
  if (GITHUB_COMMIT_SHA_PATTERN.test(target.ref)) {
    return Result.ok(target.ref.toLowerCase());
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
  if (response.isErr()) {
    return Result.err(response.error);
  }
  const body = decodeUtf8(response.value.body);
  if (body.isErr()) {
    return Result.err(body.error);
  }
  const value: unknown = JSON.parse(body.value);
  const sha = isRecord(value) ? value["sha"] : null;
  if (typeof sha !== "string" || !GITHUB_COMMIT_SHA_PATTERN.test(sha)) {
    return rejectSkillPackage("GitHub commit could not be resolved");
  }
  return Result.ok(sha.toLowerCase());
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
}): Promise<GithubTreeResult> => {
  const response = await fetchSafeBytes(
    githubTreeUrl({ owner, recursive, repo, treeish }),
    GITHUB_TREE_MAX_BYTES,
    budget,
    access,
  );
  if (response.isErr()) {
    return Result.err(response.error);
  }
  const body = decodeUtf8(response.value.body);
  if (body.isErr()) {
    return Result.err(body.error);
  }
  const value: unknown = JSON.parse(body.value);
  if (!isRecord(value) || value["truncated"] === true) {
    return rejectSkillPackage(
      "GitHub repository tree is too large to inspect safely",
    );
  }
  const tree = value["tree"];
  if (!Array.isArray(tree)) {
    return rejectSkillPackage("GitHub repository tree is invalid");
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
  return Result.ok(parsed);
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
}): Promise<Result<ArrayBuffer | null, HandlerError>> => {
  const timeoutMs = startSkillSourceRequest(budget);
  if (timeoutMs.isErr()) {
    return Result.err(timeoutMs.error);
  }
  const response = await (budget?.fetchBytes ?? safeOutboundFetchBytes)({
    headers: GITHUB_FETCH_HEADERS,
    maxBytes: GITHUB_SKILL_FILE_MAX_BYTES,
    timeoutMs: timeoutMs.value,
    url: githubRawUrl({ owner, path, ref: commitSha, repo }),
  });
  if (Result.isError(response)) {
    if (response.error.message === "Response body exceeded size limit") {
      return Result.ok(null);
    }
    return Result.err(
      new HandlerError({
        status: 400,
        message: response.error.message,
        cause: response.error,
      }),
    );
  }
  if (!response.value.ok) {
    if (response.value.status === 404) {
      return Result.ok(null);
    }
    return rejectSkillPackage(
      `Skill source returned HTTP ${response.value.status}`,
    );
  }
  return Result.ok(response.value.body);
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

const checkGithubRepositoryCoordinates = ({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}): Result<void, HandlerError> =>
  GITHUB_OWNER_PATTERN.test(owner) &&
  GITHUB_REPO_PATTERN.test(repo) &&
  repo.split("").some((character) => character !== ".")
    ? Result.ok()
    : rejectSkillPackage("GitHub repository URL is invalid");

/**
 * Runs `transform` over `items` with at most `limit` in flight. The first
 * failure stops new work; transforms already running settle before it is
 * answered. An exception a transform raises is answered as `toHandlerError`
 * would at the entry point.
 */
const mapWithConcurrency = async <T, R>({
  items,
  limit,
  transform,
}: {
  items: readonly T[];
  limit: number;
  transform: (item: T) => Promise<Result<R, HandlerError>>;
}): Promise<Result<R[], HandlerError>> => {
  const results: R[] = [];
  const failures: HandlerError[] = [];
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
    const settled = await Result.tryPromise({
      try: async () => await transform(item),
      catch: toHandlerError,
    });
    const transformed = Result.flatten(settled);
    if (transformed.isErr()) {
      failures.push(transformed.error);
      return;
    }
    results[index] = transformed.value;
    return work();
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, work);
  await Promise.all(workers);
  const failure = failures.at(0);
  return failure ? Result.err(failure) : Result.ok(results);
};

const checkSafeGithubSkillUrl = (url: URL): Result<void, HandlerError> =>
  url.protocol === "https:" && !url.username && !url.password && !url.hash
    ? Result.ok()
    : rejectSkillPackage("GitHub skill URL is not allowed");

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

const tryDecodeUtf8 = (buffer: ArrayBuffer | Uint8Array): string | null =>
  Result.try(() => UTF8_DECODER.decode(buffer)).unwrapOr(null);

const decodeUtf8 = (
  buffer: ArrayBuffer | Uint8Array,
): Result<string, HandlerError> =>
  Result.try({
    try: () => UTF8_DECODER.decode(buffer),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: "Skill files must be UTF-8 text",
        cause,
      }),
  });

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

const checkSkillResourcePath = (path: string): Result<void, HandlerError> =>
  path.length <= SKILL_PACKAGE_LIMITS.resourcePathMaxChars
    ? Result.ok()
    : rejectSkillPackage(`Skill resource path is too long: ${path}`);

const rejectSkillPackage = (message: string) =>
  Result.err(new HandlerError({ status: 400, message }));
