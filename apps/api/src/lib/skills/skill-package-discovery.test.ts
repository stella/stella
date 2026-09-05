import { Result } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";
import {
  SafeOutboundFetchError,
  type SafeOutboundFetchResponse,
} from "@/api/lib/safe-outbound-fetch";
import {
  createSkillPackageFetchContext as createSkillPackageFetchContextWithDependencies,
  discoverSkillPackagesFromUrl as discoverSkillPackagesFromUrlWithDependencies,
  fetchSkillPackageFromUrl as fetchSkillPackageFromUrlWithContext,
} from "@/api/lib/skills/skill-package";

const COMMIT_SHA = "a".repeat(40);
const SMALL_TREE_SHA = "b".repeat(40);
const SCRIPTS_TREE_SHA = "c".repeat(40);
const MAX_DEPTH_SCRIPTS_TREE_SHA = "d".repeat(40);
let outboundRequestCount = 0;
let invalidSkillScenario: "forbidden" | "missing" | "server-error" | "timeout" =
  "missing";
let activeRawRequests = 0;
let requestedRawUrls: string[] = [];
let treeScenario:
  | "default"
  | "discovery-failure"
  | "max-depth-selected-skill"
  | "scoped-folder"
  | "selected-skill" = "default";
let requestedTreeUrls: string[] = [];

const maxDepthTreeSha = (depth: number) => depth.toString(16).padStart(40, "0");

const response = (
  body: unknown,
  status = 200,
): Result<SafeOutboundFetchResponse, never> => {
  const bytes = new TextEncoder().encode(
    typeof body === "string" ? body : JSON.stringify(body),
  );
  return Result.ok({
    body: bytes.buffer,
    headers: new Headers(),
    ok: status >= 200 && status < 300,
    status,
  });
};

const invalidSkillStatus = (): number => {
  if (invalidSkillScenario === "forbidden") {
    return 403;
  }
  if (invalidSkillScenario === "server-error") {
    return 503;
  }
  return 404;
};

const safeOutboundFetchBytesMock: NonNullable<
  Parameters<typeof createSkillPackageFetchContextWithDependencies>[1]
> = async ({ url }) => {
  const requestUrl = typeof url === "string" ? new URL(url) : url;
  outboundRequestCount += 1;
  if (requestUrl.hostname === "raw.githubusercontent.com") {
    requestedRawUrls.push(requestUrl.toString());
    if (treeScenario === "discovery-failure") {
      if (requestUrl.pathname.endsWith("/failure/SKILL.md")) {
        return Result.err(
          new SafeOutboundFetchError({ message: "Request timed out" }),
        );
      }
      activeRawRequests += 1;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
      activeRawRequests -= 1;
    }
    if (requestUrl.pathname.endsWith("/invalid/SKILL.md")) {
      if (invalidSkillScenario === "timeout") {
        return Result.err(
          new SafeOutboundFetchError({ message: "Request timed out" }),
        );
      }
      return response("", invalidSkillStatus());
    }
    if (requestUrl.pathname.endsWith(`/${COMMIT_SHA}/SKILL.md`)) {
      return response(`---
name: root-skill
description: A selected repository-root skill.
---

Instructions.`);
    }
    if (requestUrl.pathname.endsWith(`/${COMMIT_SHA}/small/SKILL.md`)) {
      return response(`---
name: small-skill
description: A skill inside a large repository.
---

Instructions.`);
    }
    if (requestUrl.pathname.endsWith("/small/scripts/helper.ts")) {
      return response("export const helper = true;");
    }
    if (
      treeScenario === "max-depth-selected-skill" &&
      requestUrl.pathname.endsWith("/scripts/helper.ts")
    ) {
      return response("export const helper = true;");
    }
    if (
      treeScenario === "max-depth-selected-skill" &&
      requestUrl.pathname.endsWith("/SKILL.md")
    ) {
      return response(`---
name: max-depth-skill
description: A selected skill at the directory-depth boundary.
---

Instructions.`);
    }
    return response(`---
name: valid-skill
description: A valid discovered skill.
---

Instructions.`);
  }
  if (requestUrl.pathname.endsWith("/commits/main")) {
    return response({ sha: COMMIT_SHA });
  }
  if (requestUrl.pathname.includes("/git/trees/")) {
    requestedTreeUrls.push(requestUrl.toString());
    const treeish = requestUrl.pathname.split("/").at(-1);
    const recursive = requestUrl.searchParams.get("recursive") === "1";
    if (treeScenario === "discovery-failure") {
      return response({
        tree: Array.from({ length: 12 }, (_, index) => ({
          path: `${index === 0 ? "failure" : `skill-${index}`}/SKILL.md`,
          type: "blob",
        })),
      });
    }
    if (treeScenario === "max-depth-selected-skill") {
      if (treeish === MAX_DEPTH_SCRIPTS_TREE_SHA && recursive) {
        return response({ tree: [{ path: "helper.ts", type: "blob" }] });
      }
      if (treeish === maxDepthTreeSha(LIMITS.agentSkillGithubDirectoriesMax)) {
        return response({
          tree: [
            { path: "SKILL.md", type: "blob" },
            {
              path: "scripts",
              sha: MAX_DEPTH_SCRIPTS_TREE_SHA,
              type: "tree",
            },
          ],
        });
      }
      const currentDepth =
        treeish === COMMIT_SHA ? 0 : Number.parseInt(treeish ?? "", 16);
      return response({
        tree: [
          {
            path: `directory-${currentDepth}`,
            sha: maxDepthTreeSha(currentDepth + 1),
            type: "tree",
          },
        ],
      });
    }
    if (treeScenario !== "default") {
      if (treeish === COMMIT_SHA && recursive) {
        return response({ truncated: true, tree: [] });
      }
      if (treeish === COMMIT_SHA) {
        return response({
          tree: [{ path: "small", sha: SMALL_TREE_SHA, type: "tree" }],
        });
      }
      if (treeish === SMALL_TREE_SHA && recursive) {
        return response({
          tree:
            treeScenario === "scoped-folder"
              ? [{ path: "SKILL.md", type: "blob" }]
              : [
                  { path: "SKILL.md", type: "blob" },
                  {
                    path: "scripts/helper.ts",
                    type: "blob",
                  },
                ],
        });
      }
      if (treeish === SMALL_TREE_SHA) {
        return response({
          tree: [
            { path: "SKILL.md", type: "blob" },
            { path: "scripts", sha: SCRIPTS_TREE_SHA, type: "tree" },
          ],
        });
      }
      if (treeish === SCRIPTS_TREE_SHA && recursive) {
        return response({
          tree: [{ path: "helper.ts", type: "blob" }],
        });
      }
    }
    return response({
      tree: [
        { path: "SKILL.md", type: "blob" },
        { path: "invalid/SKILL.md", type: "blob" },
        { path: "valid/SKILL.md", type: "blob" },
      ],
    });
  }
  return response({ default_branch: "main" });
};

const createSkillPackageFetchContext = (
  limits: Parameters<typeof createSkillPackageFetchContextWithDependencies>[0],
) =>
  createSkillPackageFetchContextWithDependencies(
    limits,
    safeOutboundFetchBytesMock,
  );

const discoverSkillPackagesFromUrl = async (rawUrl: string) =>
  await discoverSkillPackagesFromUrlWithDependencies(
    rawUrl,
    safeOutboundFetchBytesMock,
  );

const fetchSkillPackageFromUrl = async (
  rawUrl: string,
  context = createSkillPackageFetchContext({
    deadlineAt: Date.now() + 30_000,
    maxRequests: 1000,
  }),
) => await fetchSkillPackageFromUrlWithContext(rawUrl, context);

describe("GitHub skill package discovery", () => {
  beforeEach(() => {
    invalidSkillScenario = "missing";
    activeRawRequests = 0;
    requestedRawUrls = [];
    treeScenario = "default";
    requestedTreeUrls = [];
  });

  test("keeps valid siblings when one skill source is missing", async () => {
    const result = await discoverSkillPackagesFromUrl(
      "https://github.com/example/skills",
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.invalidSkillCount).toBe(1);
    expect(result.value.skills.map((skill) => skill.name)).toEqual([
      "root-skill",
      "valid-skill",
    ]);
  });

  test("propagates retryable source failures after tree discovery", async () => {
    for (const [scenario, message] of [
      ["timeout", "Request timed out"],
      ["forbidden", "Skill source returned HTTP 403"],
      ["server-error", "Skill source returned HTTP 503"],
    ] as const) {
      invalidSkillScenario = scenario;
      const result = await discoverSkillPackagesFromUrl(
        "https://github.com/example/skills",
      );

      expect(Result.isError(result)).toBe(true);
      if (Result.isOk(result)) {
        throw new Error("Expected retryable source failure to propagate");
      }
      expect(result.error.message).toBe(message);
    }
  });

  test("stops scheduling discovery work after a source failure", async () => {
    treeScenario = "discovery-failure";
    const result = await discoverSkillPackagesFromUrl(
      "https://github.com/example/skills",
    );

    expect(Result.isError(result)).toBe(true);
    expect(requestedRawUrls).toHaveLength(6);
    expect(activeRawRequests).toBe(0);
  });

  test("keeps direct root SKILL.md discovery scoped to that file", async () => {
    treeScenario = "selected-skill";
    const result = await discoverSkillPackagesFromUrl(
      `https://github.com/example/skills/blob/${COMMIT_SHA}/SKILL.md`,
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.invalidSkillCount).toBe(0);
    expect(result.value.skills.map((skill) => skill.name)).toEqual([
      "root-skill",
    ]);
    expect(requestedTreeUrls).toEqual([]);
  });

  test("scopes folder discovery below an oversized repository root", async () => {
    treeScenario = "scoped-folder";
    const result = await discoverSkillPackagesFromUrl(
      `https://github.com/example/skills/tree/${COMMIT_SHA}/small`,
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.skills.map((skill) => skill.name)).toEqual([
      "small-skill",
    ]);
    expect(
      requestedTreeUrls.some(
        (url) =>
          url.includes(`/git/trees/${COMMIT_SHA}`) &&
          url.includes("recursive=1"),
      ),
    ).toBe(false);
    expect(
      requestedTreeUrls.some(
        (url) =>
          url.includes(`/git/trees/${SMALL_TREE_SHA}`) &&
          url.includes("recursive=1"),
      ),
    ).toBe(true);
  });

  test("rejects selected folders deeper than the GitHub directory cap", async () => {
    const nestedPath = Array.from(
      { length: LIMITS.agentSkillGithubDirectoriesMax + 1 },
      (_, index) => `directory-${index}`,
    ).join("/");
    const result = await discoverSkillPackagesFromUrl(
      `https://github.com/example/skills/tree/${COMMIT_SHA}/${nestedPath}`,
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected excessive GitHub folder depth to be rejected");
    }
    expect(result.error.message).toBe(
      "GitHub skill folder is too deeply nested",
    );
    expect(requestedTreeUrls).toEqual([]);
  });

  test("imports a selected skill without recursively fetching the repository root", async () => {
    treeScenario = "selected-skill";
    const result = await fetchSkillPackageFromUrl(
      `https://github.com/example/skills/blob/${COMMIT_SHA}/small/SKILL.md`,
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.name).toBe("small-skill");
    expect(result.value.resources.map((resource) => resource.path)).toEqual([
      "scripts/helper.ts",
    ]);
    expect(
      requestedTreeUrls.some(
        (url) =>
          url.includes(`/git/trees/${COMMIT_SHA}`) &&
          url.includes("recursive=1"),
      ),
    ).toBe(false);
  });

  test("imports resources for a selected skill at the directory cap", async () => {
    treeScenario = "max-depth-selected-skill";
    const nestedPath = Array.from(
      { length: LIMITS.agentSkillGithubDirectoriesMax },
      (_, index) => `directory-${index}`,
    ).join("/");
    const result = await fetchSkillPackageFromUrl(
      `https://github.com/example/skills/blob/${COMMIT_SHA}/${nestedPath}/SKILL.md`,
    );

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.name).toBe("max-depth-skill");
    expect(result.value.resources.map((resource) => resource.path)).toEqual([
      "scripts/helper.ts",
    ]);
    expect(
      requestedTreeUrls.some(
        (url) =>
          url.includes(`/git/trees/${MAX_DEPTH_SCRIPTS_TREE_SHA}`) &&
          url.includes("recursive=1"),
      ),
    ).toBe(true);
  });

  test("stops a batch before exceeding its GitHub request budget", async () => {
    outboundRequestCount = 0;
    const result = await fetchSkillPackageFromUrl(
      `https://github.com/example/skills/tree/${COMMIT_SHA}`,
      createSkillPackageFetchContext({
        deadlineAt: Date.now() + 30_000,
        maxRequests: 1,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected the request budget to reject the import");
    }
    expect(result.error.message).toBe(
      "Skill import exceeded its outbound request limit",
    );
    expect(outboundRequestCount).toBe(1);
  });

  test("rejects an expired batch deadline before outbound I/O", async () => {
    outboundRequestCount = 0;
    const result = await fetchSkillPackageFromUrl(
      `https://github.com/example/skills/tree/${COMMIT_SHA}`,
      createSkillPackageFetchContext({
        deadlineAt: Date.now() - 1,
        maxRequests: 10,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected the expired deadline to reject the import");
    }
    expect(result.error.message).toBe("Skill import timed out");
    expect(outboundRequestCount).toBe(0);
  });

  test("applies the batch deadline to non-GitHub sources", async () => {
    outboundRequestCount = 0;
    const result = await fetchSkillPackageFromUrl(
      "https://example.com/SKILL.md",
      createSkillPackageFetchContext({
        deadlineAt: Date.now() - 1,
        maxRequests: 10,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      throw new Error("Expected the expired deadline to reject the import");
    }
    expect(result.error.message).toBe("Skill import timed out");
    expect(outboundRequestCount).toBe(0);
  });
});
