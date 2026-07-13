import { describe, expect, test } from "bun:test";

import { spdxLicenseUrl } from "@/lib/spdx-license";
import {
  buildMcpConfigSnippet,
  githubSkillTreeUrl,
  toolDownloadPath,
} from "@/routes/tools/-components/tool-detail.logic";

describe("tool-detail.logic", () => {
  test("download path targets the un-nested server route", () => {
    expect(toolDownloadPath("my-skill")).toBe("/tools/my-skill/download");
  });

  test("spdx url points at the canonical license page", () => {
    expect(spdxLicenseUrl("MIT")).toBe("https://spdx.org/licenses/MIT.html");
  });

  test("github tree url pins to the immutable revision", () => {
    expect(
      githubSkillTreeUrl({
        repo: "acme/skills",
        rev: "0".repeat(40),
        directory: "german-law",
      }),
    ).toBe(`https://github.com/acme/skills/tree/${"0".repeat(40)}/german-law`);
  });

  test("github tree url omits an empty directory segment", () => {
    expect(
      githubSkillTreeUrl({ repo: "acme/skills", rev: "a".repeat(40) }),
    ).toBe(`https://github.com/acme/skills/tree/${"a".repeat(40)}`);
  });

  test("mcp snippet omits auth for anonymous servers", () => {
    const snippet = buildMcpConfigSnippet({
      slug: "docs",
      url: "https://mcp.example.com",
      authType: "none",
    });
    const parsed = JSON.parse(snippet);
    expect(parsed).toEqual({
      mcpServers: {
        docs: { url: "https://mcp.example.com", transport: "http" },
      },
    });
  });

  test("mcp snippet carries oauth scopes when present", () => {
    const snippet = buildMcpConfigSnippet({
      slug: "gh",
      url: "https://mcp.example.com",
      authType: "oauth",
      oauthRequestedScopes: ["repo", "read:org"],
    });
    const parsed = JSON.parse(snippet);
    expect(parsed.mcpServers.gh.auth).toEqual({
      type: "oauth",
      scopes: ["repo", "read:org"],
    });
  });

  test("mcp snippet emits a bare oauth block when no scopes are requested", () => {
    const snippet = buildMcpConfigSnippet({
      slug: "gh",
      url: "https://mcp.example.com",
      authType: "oauth",
    });
    expect(JSON.parse(snippet).mcpServers.gh.auth).toEqual({ type: "oauth" });
  });

  test("mcp snippet never emits secrets, only a bearer marker", () => {
    const snippet = buildMcpConfigSnippet({
      slug: "gh",
      url: "https://mcp.example.com",
      authType: "bearer",
    });
    expect(JSON.parse(snippet).mcpServers.gh.auth).toEqual({ type: "bearer" });
    expect(snippet).not.toMatch(/token|secret|key/iu);
  });
});
