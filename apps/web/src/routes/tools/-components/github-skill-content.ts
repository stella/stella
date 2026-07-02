import { createServerFn } from "@tanstack/react-start";
import * as v from "valibot";

import {
  githubRawContentBaseUrl,
  isGithubSkillEntry,
  loadCatalogue,
} from "@stll/catalogue";

import { MAX_GITHUB_SKILL_BYTES } from "@/routes/tools/-components/tool-detail.logic";

/**
 * Result of fetching a github-sourced skill's `SKILL.md`. Deliberately
 * a two-state union with no error detail: the public detail page only
 * decides "render markdown" vs "degrade to metadata + external link".
 */
export type GithubSkillContentResult =
  | { status: "ok"; markdown: string }
  | { status: "error" };

// The RPC input is a catalogue slug, not a repo/rev pair: the server
// resolves the pin from the static bundle, so this endpoint can only
// ever fetch content the catalogue actually references (no arbitrary
// GitHub fetch proxy) and the cache is bounded by the entry count.
const inputSchema = v.strictObject({
  slug: v.string(),
});

// Content at a pinned commit SHA is immutable, so a successful fetch is
// cached for the process lifetime keyed by the pin. Only successes are
// cached: a transient network failure must not poison the entry.
const successCache = new Map<string, GithubSkillContentResult>();

const withinByteCap = (value: string): boolean =>
  new TextEncoder().encode(value).byteLength <= MAX_GITHUB_SKILL_BYTES;

const loadRawSkill = async (url: string): Promise<GithubSkillContentResult> => {
  // Boundary layer: an external fetch to an untrusted host. Any failure
  // (timeout, non-200, oversize, parse) degrades to metadata-only.
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      return { status: "error" };
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_GITHUB_SKILL_BYTES
    ) {
      return { status: "error" };
    }
    const markdown = await response.text();
    if (!withinByteCap(markdown)) {
      return { status: "error" };
    }
    return { status: "ok", markdown };
  } catch {
    return { status: "error" };
  }
};

/**
 * Server function: fetch a github-sourced skill's `SKILL.md` at its
 * pinned SHA from `raw.githubusercontent.com`, with a timeout, a byte
 * cap, and process-lifetime caching of successes. Runs server-side
 * during SSR and via RPC on client navigation.
 */
export const fetchGithubSkillContent = createServerFn({ method: "GET" })
  .inputValidator((input: v.InferInput<typeof inputSchema>) =>
    v.parse(inputSchema, input),
  )
  .handler(async ({ data }): Promise<GithubSkillContentResult> => {
    const entry = loadCatalogue().find(
      (candidate) => candidate.kind === "skill" && candidate.slug === data.slug,
    );
    if (!entry || !isGithubSkillEntry(entry)) {
      return { status: "error" };
    }
    const key = `${entry.repo}@${entry.rev}/${entry.directory ?? ""}`;
    const cached = successCache.get(key);
    if (cached) {
      return cached;
    }
    const result = await loadRawSkill(
      `${githubRawContentBaseUrl(entry)}SKILL.md`,
    );
    if (result.status === "ok") {
      successCache.set(key, result);
    }
    return result;
  });
