import { Result } from "better-result";
import JSZip from "jszip";

import {
  getSkillResourceKind,
  isAllowedResourcePath,
  normalizeResourcePath,
  parseSkillFile,
} from "@stll/skills";
import type { SkillResourceKind } from "@stll/skills";

import { safeMcpFetchBytes } from "@/api/handlers/mcp-connectors/url-safety";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_API_TIMEOUT_MS = 10_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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

type GithubTreeItem = {
  path: string;
  type: string;
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
): Promise<Result<ParsedSkillPackage, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const githubPath = parseGithubSkillPath(rawUrl);
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
  const files: SkillFile[] = [];

  for (const file of Object.values(zip.files)) {
    if (file.dir || file.name.startsWith("__MACOSX/")) {
      continue;
    }
    const normalizedPath = normalizePackageFilePath(file.name);
    if (!normalizedPath) {
      continue;
    }
    const content = await file.async("string");
    files.push({
      content,
      path: normalizedPath,
      sizeBytes: encodedSize(content),
    });
  }

  return parseSkillFiles(files);
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
  const treeUrl = new URL(
    `https://api.github.com/repos/${target.owner}/${target.repo}/git/trees/${target.ref}`,
  );
  treeUrl.searchParams.set("recursive", "1");

  const response = await fetchSafeBytes(treeUrl);
  const tree = parseGithubTreeResponse(JSON.parse(decodeUtf8(response.body)));
  const rootPrefix = target.rootPath ? `${target.rootPath}/` : "";
  const wanted = tree
    .filter((item) => item.type === "blob")
    .filter((item) =>
      rootPrefix.length === 0
        ? item.path === SKILL_FILE_NAME ||
          item.path.startsWith("references/") ||
          item.path.startsWith("reference/") ||
          item.path.startsWith("knowledge/") ||
          item.path.startsWith("prompts/") ||
          item.path.startsWith("templates/") ||
          item.path.startsWith("assets/") ||
          item.path.startsWith("scripts/")
        : item.path.startsWith(rootPrefix),
    )
    .filter((item) => {
      const relative =
        rootPrefix.length > 0 ? item.path.slice(rootPrefix.length) : item.path;
      return (
        relative === SKILL_FILE_NAME ||
        isAllowedResourcePath(normalizeResourcePath(relative))
      );
    })
    .slice(0, LIMITS.agentSkillResourcesPerSkill + 1);

  const files = await Promise.all(
    wanted.map(async (item): Promise<SkillFile> => {
      const rawUrl = githubRawUrl({
        owner: target.owner,
        path: item.path,
        ref: target.ref,
        repo: target.repo,
      });
      const raw = await fetchSafeBytes(rawUrl);
      const content = decodeUtf8(raw.body);
      const relativePath =
        rootPrefix.length > 0 ? item.path.slice(rootPrefix.length) : item.path;
      return {
        content,
        path: relativePath,
        sizeBytes: encodedSize(content),
      };
    }),
  );

  const parsed = parseSkillFiles(files);
  return { ...parsed, sourceUrl: originalUrl };
};

const fetchSafeBytes = async (url: URL) => {
  const response = await safeMcpFetchBytes({
    headers: {
      Accept: "application/vnd.github+json, text/plain, application/zip",
      "User-Agent": "Stella skill importer",
    },
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

const parseGithubSkillPath = (rawUrl: string): GithubSkillPath | null => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HandlerError({ status: 400, message: "Skill URL is invalid" });
  }

  if (url.hostname === "raw.githubusercontent.com") {
    const [owner, repo, ref, ...filePath] = pathParts(url);
    if (!owner || !repo || !ref || filePath.length === 0) {
      return null;
    }
    const rootPath =
      filePath.at(-1) === SKILL_FILE_NAME
        ? filePath.slice(0, -1).join("/")
        : filePath.join("/");
    return { owner, ref, repo, rootPath };
  }

  if (url.hostname !== "github.com") {
    return null;
  }

  const [owner, repo, kind, ref, ...path] = pathParts(url);
  if (!owner || !repo || !kind || !ref) {
    return null;
  }
  if (kind !== "tree" && kind !== "blob") {
    return null;
  }

  const rootPath =
    path.at(-1) === SKILL_FILE_NAME
      ? path.slice(0, -1).join("/")
      : path.join("/");
  return { owner, ref, repo, rootPath };
};

const parseGithubTreeResponse = (value: unknown): GithubTreeItem[] => {
  if (!isRecord(value) || !Array.isArray(value["tree"])) {
    throw new HandlerError({
      status: 400,
      message: "GitHub skill tree response is invalid",
    });
  }

  const items: GithubTreeItem[] = [];
  for (const item of value["tree"]) {
    if (!isRecord(item)) {
      continue;
    }
    const path = item["path"];
    const type = item["type"];
    if (typeof path === "string" && typeof type === "string") {
      items.push({ path, type });
    }
  }
  return items;
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

const pathParts = (url: URL): string[] =>
  url.pathname.split("/").filter((part) => part.length > 0);

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
  hasher.update(source);
  for (const resource of resources) {
    hasher.update("\0");
    hasher.update(resource.path);
    hasher.update("\0");
    hasher.update(resource.content);
  }
  return hasher.digest("hex");
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

const decodeUtf8 = (buffer: ArrayBuffer): string => {
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
