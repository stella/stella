import { Result } from "better-result";

import { sleep as ownerSleep } from "@stll/concurrency/sleep";
import { sha256Hex } from "@stll/sha256/bun";
import { parseSkillFile } from "@stll/skills";
import { SKILL_PACKAGE_LIMITS } from "@stll/skills/package-limits";
import { readCappedBytes } from "@stll/skills/streaming";

import {
  PinnedContentError,
  assertCompleteGithubContentsListing,
  projectFrontmatter,
  type GithubTarget,
  type GithubContentItem,
  type PinnedSource,
} from "./pinned-content-facts";

const FETCH_TIMEOUT_MS = 10_000;
const FETCH_RETRY_DELAYS_MS = [200, 800] as const;
const SKILL_FILE_NAME = "SKILL.md";

const RESOURCE_MAX_BYTES = SKILL_PACKAGE_LIMITS.resourceMaxChars * 4;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

type Fetcher = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
type RetrySleep = (delayMs: number) => Promise<void>;

type FetchWithBoundedRetryOptions<T> = {
  fetchValue: () => Promise<T>;
  sleep?: RetrySleep;
};

/** Retry rejected transports twice; tagged response failures stay single-pass. */
export const fetchWithBoundedRetry = async <T>({
  fetchValue,
  sleep: wait = ownerSleep,
}: FetchWithBoundedRetryOptions<T>): Promise<T> => {
  const attempt = async (retryIndex: number): Promise<T> => {
    const fetched = await Result.tryPromise({
      try: fetchValue,
      catch: (cause) => cause,
    });
    if (Result.isOk(fetched)) {
      return fetched.value;
    }

    const delayMs = FETCH_RETRY_DELAYS_MS.at(retryIndex);
    if (fetched.error instanceof PinnedContentError || delayMs === undefined) {
      throw fetched.error;
    }
    await wait(delayMs);
    return await attempt(retryIndex + 1);
  };

  return await attempt(0);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toContentItems = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) {
    return payload;
  }
  return isRecord(payload) ? [payload] : [];
};

const githubHeaders = (accept: string): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "stella-catalogue-pinned-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env["GITHUB_TOKEN"];
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
};

const joinRepoPath = (directory: string, relative: string): string =>
  directory ? `${directory}/${relative}` : relative;

const encodePath = (repoRelativePath: string): string =>
  repoRelativePath
    .split("/")
    .filter((part) => part.length > 0)
    .map(encodeURIComponent)
    .join("/");

const rawContentUrl = (
  target: GithubTarget,
  repoRelativePath: string,
): string =>
  `https://raw.githubusercontent.com/${target.repo}/${target.rev}/${encodePath(repoRelativePath)}`;

const contentsApiUrl = (
  target: GithubTarget,
  repoRelativePath: string,
): string => {
  const encoded = encodePath(repoRelativePath);
  const url = new URL(
    encoded.length > 0
      ? `https://api.github.com/repos/${target.repo}/contents/${encoded}`
      : `https://api.github.com/repos/${target.repo}/contents`,
  );
  url.searchParams.set("ref", target.rev);
  return url.toString();
};

type FetchPinnedTextFileOptions = {
  allowNotFound?: boolean;
  fetcher?: Fetcher;
  label: string;
  maxBytes: number;
  repoRelativePath: string;
  sleep?: RetrySleep;
  target: GithubTarget;
};

type PinnedTextFile = { byteLength: number; content: string; sha256: string };

export const fetchPinnedTextFile = async ({
  allowNotFound = false,
  fetcher = fetch,
  label,
  maxBytes,
  repoRelativePath,
  sleep: wait = ownerSleep,
  target,
}: FetchPinnedTextFileOptions): Promise<PinnedTextFile | null> => {
  const fetchValue = async () => {
    const response = await fetcher(rawContentUrl(target, repoRelativePath), {
      headers: githubHeaders("text/plain"),
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 404 && allowNotFound) {
      return null;
    }
    if (!response.ok) {
      throw new PinnedContentError({
        message: `${label} fetch returned HTTP ${response.status}`,
      });
    }
    if (!response.body) {
      throw new PinnedContentError({
        message: `${label} response has no body`,
      });
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new PinnedContentError({
        message: `${label} is larger than ${maxBytes} bytes`,
      });
    }
    const bytes = await readCappedBytes(response.body, maxBytes);
    if (bytes === null) {
      throw new PinnedContentError({
        message: `${label} is larger than ${maxBytes} bytes`,
      });
    }
    return bytes;
  };
  const file = await fetchWithBoundedRetry({
    fetchValue,
    sleep: wait,
  });
  if (file === null) {
    return null;
  }
  return {
    byteLength: file.byteLength,
    content: UTF8_DECODER.decode(file),
    sha256: sha256Hex(file),
  };
};

/**
 * Fetch the pinned `SKILL.md` as text. Returns null on a 404 so the
 * caller can report the specific "not found at pinned rev" failure;
 * every other non-2xx response and any redirect throws.
 */
const fetchSkillFile = async (
  target: GithubTarget,
): Promise<PinnedTextFile | null> =>
  await fetchPinnedTextFile({
    allowNotFound: true,
    label: SKILL_FILE_NAME,
    maxBytes: RESOURCE_MAX_BYTES,
    repoRelativePath: joinRepoPath(target.directory, SKILL_FILE_NAME),
    target,
  });

type FetchDirectoryContentsOptions = {
  fetcher?: Fetcher;
  repoRelativePath: string;
  sleep?: RetrySleep;
  target: GithubTarget;
};

export const fetchDirectoryContents = async ({
  fetcher = fetch,
  repoRelativePath,
  sleep: wait = ownerSleep,
  target,
}: FetchDirectoryContentsOptions): Promise<{
  items: GithubContentItem[];
  itemCount: number;
}> => {
  const fetchValue = async () => {
    const response = await fetcher(contentsApiUrl(target, repoRelativePath), {
      headers: githubHeaders("application/vnd.github+json"),
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // A missing resource directory is not an error: the skill simply has
    // no files under that root.
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new PinnedContentError({
        message: `GitHub contents API returned HTTP ${response.status} for ${repoRelativePath || "<root>"}`,
      });
    }
    return await response.text();
  };
  const body = await fetchWithBoundedRetry({
    fetchValue,
    sleep: wait,
  });
  if (body === null) {
    return { items: [], itemCount: 0 };
  }

  const payload: unknown = JSON.parse(body);
  const items = toContentItems(payload);
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
  assertCompleteGithubContentsListing({
    itemCount: items.length,
    repoRelativePath,
  });
  return { items: parsed, itemCount: items.length };
};

export const upstreamPinnedSource: PinnedSource = {
  skill: async (target) => {
    const file = await fetchSkillFile(target);
    if (file === null) {
      return null;
    }
    const parsed = parseSkillFile(file.content);
    if (parsed.isErr()) {
      throw new PinnedContentError({
        message: `${target.slug}: SKILL.md frontmatter is invalid`,
      });
    }
    return {
      sha256: file.sha256,
      byteLength: file.byteLength,
      utf16Length: file.content.length,
      bodyUtf16Length: parsed.value.body.length,
      frontmatter: projectFrontmatter(parsed.value.metadata),
    };
  },
  directory: async ({ directory, target }) =>
    await fetchDirectoryContents({ repoRelativePath: directory, target }),
  resource: async ({ path, target }) => {
    const file = await fetchPinnedTextFile({
      label: `resource ${path}`,
      maxBytes: RESOURCE_MAX_BYTES,
      repoRelativePath: path,
      target,
    });
    return file === null
      ? null
      : {
          sha256: file.sha256,
          byteLength: file.byteLength,
          utf16Length: file.content.length,
        };
  },
};
