/**
 * Pure helpers for the public tool detail surface. No React, no
 * `@stll/catalogue` runtime imports, no network: kept trivially
 * testable against plain objects and safe to import from either the SSR
 * route module or a client chunk.
 */

/** Public GitHub source of the Stella monorepo (mirrors apps/landing). */
export const STELLA_REPO_URL = "https://github.com/stella/stella";

/** CONTRIBUTING guide for catalogue entries, on the default branch. */
export const CATALOGUE_CONTRIBUTING_URL = `${STELLA_REPO_URL}/blob/main/packages/catalogue/CONTRIBUTING.md`;

/** Catalogue entries folder on the default branch. */
export const CATALOGUE_ENTRIES_URL = `${STELLA_REPO_URL}/tree/main/packages/catalogue/entries`;

/**
 * Byte cap for a fetched `SKILL.md`. The manifest body is prose, not a
 * corpus; anything larger is almost certainly the wrong file or an
 * abusive upstream, so we degrade to metadata rather than stream it.
 */

/** Server download route for an in-tree skill's zip bundle. */
export const toolDownloadPath = (slug: string): `/${string}` =>
  `/tools/${slug}/download`;

type GithubSkillLocator = {
  repo: string;
  rev: string;
  directory?: string | undefined;
};

/** Human-facing GitHub tree URL for a github-sourced skill at its pin. */
export const githubSkillTreeUrl = ({
  repo,
  rev,
  directory,
}: GithubSkillLocator): string =>
  `https://github.com/${repo}/tree/${rev}${directory ? `/${directory}` : ""}`;

type McpConfigInput = {
  slug: string;
  url: string;
  authType: "none" | "bearer" | "oauth";
  oauthRequestedScopes?: readonly string[];
};

/**
 * Client-agnostic MCP connection snippet using the widely-supported
 * `mcpServers` shape. Auth is described declaratively so any MCP client
 * can map it; secrets are never emitted (the user supplies credentials
 * in their own client).
 */
export const buildMcpConfigSnippet = ({
  slug,
  url,
  authType,
  oauthRequestedScopes = [],
}: McpConfigInput): string => {
  const server: Record<string, unknown> = { url, transport: "http" };
  if (authType === "bearer") {
    server["auth"] = { type: "bearer" };
  }
  if (authType === "oauth") {
    server["auth"] = {
      type: "oauth",
      ...(oauthRequestedScopes.length > 0
        ? { scopes: [...oauthRequestedScopes] }
        : {}),
    };
  }
  return JSON.stringify({ mcpServers: { [slug]: server } }, null, 2);
};
