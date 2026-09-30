import { describe, expect, test } from "bun:test";
import nodeOs from "node:os";
import nodePath from "node:path";

import {
  buildCommit,
  buildCommitMismatch,
  buildTargets,
  classifyPublicKnowledgeHead,
  declaredCacheControl,
  evaluateCachePolicy,
  evaluateRobots,
  evaluateStatus,
  firstPublicPackId,
  firstStarterId,
  firstTemplateId,
  hasZeroAge,
  headMetaContents,
  isCdnCacheHit,
  matchesCacheControl,
  MEMBER_JSON_CACHE_CONTROL,
  MEMBER_JSON_POLICY_PATHS,
  parseCacheControl,
  resolvePublicKnowledgeState,
  RESPONSE_CLASS,
} from "@/api/scripts/post-deploy-response-policy";

const cdnHeaders = (headers: Record<string, string>): Headers =>
  new Headers({ "x-amz-cf-id": "request-id", ...headers });

const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json";

describe("post-deploy response policy module graph", () => {
  test("loads without the app environment", async () => {
    const emptyEnvFile = nodePath.join(
      nodeOs.tmpdir(),
      "stella-post-deploy-response-policy-empty.env",
    );
    await Bun.write(emptyEnvFile, "");
    const moduleUrl = new URL("post-deploy-response-policy.ts", import.meta.url)
      .href;
    const imported = Bun.spawnSync({
      cmd: [
        process.execPath,
        `--env-file=${emptyEnvFile}`,
        "-e",
        `await import(${JSON.stringify(moduleUrl)})`,
      ],
      env: { HOME: process.env["HOME"], PATH: process.env["PATH"] },
    });

    expect(imported.stderr.toString()).toBe("");
    expect(imported.exitCode).toBe(0);
  });
});

describe("cache headers", () => {
  test("parses directives case-insensitively with values", () => {
    const directives = parseCacheControl("Private, NO-STORE, max-age=0");
    expect(directives.has("private")).toBe(true);
    expect(directives.has("no-store")).toBe(true);
    expect(directives.get("max-age")).toBe("0");
    expect(parseCacheControl(null).size).toBe(0);
  });

  test("matches the declared directives exactly, in any order", () => {
    expect(matchesCacheControl("no-store,  private", "private, no-store")).toBe(
      true,
    );
    expect(matchesCacheControl("no-store", "private, no-store")).toBe(false);
    expect(
      matchesCacheControl("private, no-store, max-age=0", "private, no-store"),
    ).toBe(false);
    expect(
      matchesCacheControl("public, max-age=60", "public, max-age=300"),
    ).toBe(false);
    expect(matchesCacheControl(null, "no-store")).toBe(false);
  });

  test("treats Hit and RefreshHit as CDN cache hits", () => {
    expect(isCdnCacheHit("Hit from cloudfront")).toBe(true);
    expect(isCdnCacheHit("RefreshHit from cloudfront")).toBe(true);
    expect(isCdnCacheHit("Miss from cloudfront")).toBe(false);
    expect(isCdnCacheHit("Error from cloudfront")).toBe(false);
    expect(isCdnCacheHit(null)).toBe(false);
  });

  test("accepts only an absent or zero Age", () => {
    expect(hasZeroAge(null)).toBe(true);
    expect(hasZeroAge("0")).toBe(true);
    expect(hasZeroAge("12")).toBe(false);
  });
});

describe("declaredCacheControl", () => {
  const page = { responseClass: RESPONSE_CLASS.page };

  test("declares private, no-store for Knowledge HTML only", () => {
    expect(
      declaredCacheControl(page, {
        status: 200,
        headers: new Headers({ "content-type": HTML }),
      }),
    ).toBe("private, no-store");
    expect(
      declaredCacheControl(
        { responseClass: RESPONSE_CLASS.accountPage },
        { status: 404, headers: new Headers({ "content-type": HTML }) },
      ),
    ).toBe("private, no-store");
    expect(
      declaredCacheControl(page, { status: 307, headers: new Headers() }),
    ).toBeNull();
  });

  test("declares the public policy on success and the private policy otherwise", () => {
    const publicJson = { responseClass: RESPONSE_CLASS.publicJson };
    expect(
      declaredCacheControl(publicJson, { status: 200, headers: new Headers() }),
    ).toBe("public, max-age=300");
    expect(
      declaredCacheControl(publicJson, { status: 404, headers: new Headers() }),
    ).toBe("private, no-store");
  });

  test("uses the member route's own declaration", () => {
    expect(
      declaredCacheControl(
        {
          responseClass: RESPONSE_CLASS.memberJson,
          cacheControl: "private, no-store",
        },
        { status: 401, headers: new Headers() },
      ),
    ).toBe("private, no-store");
    expect(
      declaredCacheControl(
        { responseClass: RESPONSE_CLASS.memberJson, cacheControl: null },
        { status: 401, headers: new Headers() },
      ),
    ).toBeNull();
  });
});

describe("evaluateCachePolicy", () => {
  const page = { responseClass: RESPONSE_CLASS.page };
  const member = {
    responseClass: RESPONSE_CLASS.memberJson,
    cacheControl: "private, no-store",
  };
  const publicJson = { responseClass: RESPONSE_CLASS.publicJson };

  test("passes a Knowledge page with the declared policy", () => {
    expect(
      evaluateCachePolicy(page, {
        status: 200,
        headers: cdnHeaders({
          "content-type": HTML,
          "cache-control": "private, no-store",
          "x-cache": "Miss from cloudfront",
        }),
      }),
    ).toEqual([]);
  });

  test("flags a different policy, a cache hit and a nonzero Age", () => {
    const failures = evaluateCachePolicy(page, {
      status: 200,
      headers: cdnHeaders({
        "content-type": HTML,
        "cache-control": "public, max-age=300",
        "x-cache": "Hit from cloudfront",
        age: "40",
      }),
    });
    expect(failures).toHaveLength(3);
  });

  test("checks member JSON only where its route declares a policy", () => {
    expect(
      evaluateCachePolicy(member, {
        status: 401,
        headers: cdnHeaders({ "cache-control": "no-store" }),
      }),
    ).toHaveLength(1);
    expect(
      evaluateCachePolicy(member, {
        status: 401,
        headers: cdnHeaders({ "cache-control": "private, no-store" }),
      }),
    ).toEqual([]);
    expect(
      evaluateCachePolicy(
        { responseClass: RESPONSE_CLASS.memberJson, cacheControl: null },
        { status: 401, headers: cdnHeaders({}) },
      ),
    ).toEqual([]);
  });

  test("leaves a redirecting page's headers alone", () => {
    expect(
      evaluateCachePolicy(page, { status: 302, headers: cdnHeaders({}) }),
    ).toEqual([]);
  });

  test("requires the declared public policy and no cookie", () => {
    expect(
      evaluateCachePolicy(publicJson, {
        status: 200,
        headers: cdnHeaders({
          "cache-control": "public, max-age=300",
          "x-cache": "Hit from cloudfront",
          age: "10",
        }),
      }),
    ).toEqual([]);
    expect(
      evaluateCachePolicy(publicJson, {
        status: 200,
        headers: cdnHeaders({
          "cache-control": "public, max-age=300",
          "set-cookie": "a=b",
        }),
      }),
    ).toEqual(["public response sets a cookie"]);
    expect(
      evaluateCachePolicy(publicJson, {
        status: 404,
        headers: cdnHeaders({ "cache-control": "no-store" }),
      }),
    ).toEqual([]);
    expect(
      evaluateCachePolicy(publicJson, {
        status: 404,
        headers: cdnHeaders({ "cache-control": "public, max-age=300" }),
      }),
    ).toHaveLength(1);
  });

  test("requires the CDN response marker", () => {
    expect(
      evaluateCachePolicy(page, {
        status: 200,
        headers: new Headers({
          "content-type": HTML,
          "cache-control": "private, no-store",
        }),
      }),
    ).toEqual(["no CDN response marker"]);
  });
});

describe("evaluateStatus", () => {
  const html = new Headers({ "content-type": HTML });
  const json = new Headers({ "content-type": JSON_TYPE });

  test("member JSON answers a JSON 401", () => {
    const context = {
      responseClass: RESPONSE_CLASS.memberJson,
      publicKnowledge: "enabled",
    } as const;
    expect(evaluateStatus(context, { status: 401, headers: json })).toEqual([]);
    expect(
      evaluateStatus(context, {
        status: 401,
        headers: new Headers({ "content-type": `${JSON_TYPE}; charset=utf-8` }),
      }),
    ).toEqual([]);
    expect(
      evaluateStatus(context, { status: 200, headers: json }),
    ).toHaveLength(1);
    expect(evaluateStatus(context, { status: 401, headers: html })).toEqual([
      "content type text/html",
    ]);
    expect(
      evaluateStatus(context, { status: 401, headers: new Headers() }),
    ).toEqual(["content type absent"]);
  });

  test("public pages and JSON follow the public Knowledge state", () => {
    const enabled = { publicKnowledge: "enabled" } as const;
    const disabled = { publicKnowledge: "disabled" } as const;
    const page = RESPONSE_CLASS.page;
    const publicJson = RESPONSE_CLASS.publicJson;

    expect(
      evaluateStatus(
        { ...enabled, responseClass: page },
        { status: 200, headers: html },
      ),
    ).toEqual([]);
    expect(
      evaluateStatus(
        { ...enabled, responseClass: page },
        { status: 302, headers: html },
      ),
    ).toHaveLength(1);
    expect(
      evaluateStatus(
        { ...disabled, responseClass: page },
        { status: 302, headers: html },
      ),
    ).toEqual([]);
    expect(
      evaluateStatus(
        { ...disabled, responseClass: page },
        { status: 404, headers: html },
      ),
    ).toEqual([]);

    expect(
      evaluateStatus(
        { ...enabled, responseClass: publicJson },
        { status: 200, headers: json },
      ),
    ).toEqual([]);
    expect(
      evaluateStatus(
        { ...disabled, responseClass: publicJson },
        { status: 404, headers: json },
      ),
    ).toEqual([]);
    expect(
      evaluateStatus(
        { ...disabled, responseClass: publicJson },
        { status: 200, headers: json },
      ),
    ).toHaveLength(1);
  });

  test("account pages render or redirect", () => {
    const context = {
      responseClass: RESPONSE_CLASS.accountPage,
      publicKnowledge: "enabled",
    } as const;
    expect(evaluateStatus(context, { status: 307, headers: html })).toEqual([]);
    expect(evaluateStatus(context, { status: 200, headers: html })).toEqual([]);
    expect(
      evaluateStatus(context, { status: 500, headers: html }),
    ).toHaveLength(1);
  });

  test("a request that did not complete fails", () => {
    expect(
      evaluateStatus(
        {
          responseClass: RESPONSE_CLASS.publicJson,
          publicKnowledge: "disabled",
        },
        { status: 0, headers: new Headers() },
      ),
    ).toEqual(["request did not complete"]);
  });
});

describe("head meta tags", () => {
  test("reads the public Knowledge marker from the head only", () => {
    expect(
      classifyPublicKnowledgeHead(
        '<html><head><meta name="public-knowledge" content="enabled"></head><body></body></html>',
      ),
    ).toBe("enabled");
    expect(
      classifyPublicKnowledgeHead("<html><head><title>x</title></head></html>"),
    ).toBe("disabled");
    expect(
      classifyPublicKnowledgeHead(
        '<html><head></head><body><meta name="public-knowledge" content="enabled"></body></html>',
      ),
    ).toBe("disabled");
    expect(
      classifyPublicKnowledgeHead(
        "<head><meta content='on' name='public-knowledge'/></head>",
      ),
    ).toBe("unexpected");
  });

  test("accepts only the declared robots values", () => {
    expect(
      evaluateRobots(
        '<head><meta name="robots" content="noindex,nofollow"/></head>',
      ),
    ).toEqual([]);
    expect(
      evaluateRobots(
        '<head><meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1"/></head>',
      ),
    ).toEqual([]);
    expect(
      evaluateRobots('<head><meta name="robots" content="index"/></head>'),
    ).toHaveLength(1);
    expect(evaluateRobots("<head><title>x</title></head>")).toEqual([
      "no robots meta tag",
    ]);
    expect(
      headMetaContents(
        '<head></head><body><meta name="robots" content="index"></body>',
        "robots",
      ),
    ).toEqual([]);
  });

  test("reads head meta elements across attribute forms", () => {
    for (const marker of [
      '<meta name="public-knowledge" content="enabled">',
      "<meta content='enabled' name='public-knowledge' />",
      '<META CONTENT = "enabled" NAME = "public-knowledge">',
      "<meta name=public-knowledge content=enabled>",
    ]) {
      expect(
        classifyPublicKnowledgeHead(
          `<html><head>${marker}</head><body></body></html>`,
        ),
      ).toBe("enabled");
    }
  });

  test("ignores lookalikes in scripts, styles, templates and comments", () => {
    const lookalikes = (tag: string) => [
      `<script>const tag = '${tag}';</script>`,
      `<script type="application/json">{"tag":"${tag.replaceAll('"', '\\"')}"}</script>`,
      `<style>body::before { content: '${tag}'; }</style>`,
      `<template>${tag}</template>`,
      `<!-- ${tag} -->`,
      `<title>${tag}</title>`,
    ];
    for (const head of lookalikes(
      '<meta name="public-knowledge" content="enabled">',
    )) {
      expect(
        classifyPublicKnowledgeHead(
          `<html><head>${head}</head><body></body></html>`,
        ),
      ).toBe("disabled");
    }
    for (const head of lookalikes('<meta name="robots" content="index">')) {
      const page = `<html><head><meta name="robots" content="noindex,nofollow">${head}</head><body></body></html>`;
      expect(headMetaContents(page, "robots")).toEqual(["noindex,nofollow"]);
      expect(evaluateRobots(page)).toEqual([]);
    }
  });
});

describe("public Knowledge state", () => {
  test("requires API and web to agree", () => {
    expect(
      resolvePublicKnowledgeState({
        apiStatus: 200,
        webStatus: 200,
        webState: "enabled",
      }),
    ).toEqual({ state: "enabled" });
    expect(
      resolvePublicKnowledgeState({
        apiStatus: 404,
        webStatus: 200,
        webState: "disabled",
      }),
    ).toEqual({ state: "disabled" });
    expect(
      resolvePublicKnowledgeState({
        apiStatus: 404,
        webStatus: 200,
        webState: "enabled",
      }).state,
    ).toBe("inconsistent");
    expect(
      resolvePublicKnowledgeState({
        apiStatus: 403,
        webStatus: 200,
        webState: "disabled",
      }).state,
    ).toBe("inconsistent");
    expect(
      resolvePublicKnowledgeState({
        apiStatus: 200,
        webStatus: 200,
        webState: "unexpected",
      }).state,
    ).toBe("inconsistent");
  });
});

describe("build commits", () => {
  test("reads a commit from a build marker", () => {
    expect(buildCommit({ status: "ok", commit: "ABCDEF1234567" })).toBe(
      "abcdef1234567",
    );
    expect(buildCommit({ commit: "dev" })).toBeNull();
    expect(buildCommit({ commit: null })).toBeNull();
    expect(buildCommit({ status: "ok" })).toBeNull();
    expect(buildCommit(undefined)).toBeNull();
  });

  test("stops only when both origins report different commits", () => {
    expect(buildCommitMismatch({ api: "abc1234", web: "abc1234" })).toBeNull();
    expect(buildCommitMismatch({ api: "abc1234", web: null })).toBeNull();
    expect(buildCommitMismatch({ api: null, web: "abc1234" })).toBeNull();
    expect(buildCommitMismatch({ api: "abc1234", web: "def5678" })).toContain(
      "web serves commit def5678, API serves commit abc1234",
    );
  });
});

describe("member response policy", () => {
  test("every sampled member route carries the global policy", async () => {
    const { default: api } = await import("@/api/server");
    for (const path of MEMBER_JSON_POLICY_PATHS) {
      const apiPath = path.slice("/api".length);
      expect(
        api.routes.some(
          (route) => `${route.path}/`.replace(/\/\//gu, "/") === apiPath,
        ),
      ).toBe(true);
      const response = await api.handle(
        new Request(`http://localhost${apiPath}`),
      );
      expect(response.status, path).toBe(401);
      expect(response.headers.get("Cache-Control"), path).toBe(
        MEMBER_JSON_CACHE_CONTROL,
      );
    }
  });
});

describe("targets", () => {
  test("public ids come from the public Knowledge JSON", () => {
    expect(
      firstPublicPackId({
        items: [
          { id: "empty", templateCount: 0 },
          { id: "pack-one", templateCount: 3 },
        ],
      }),
    ).toBe("pack-one");
    expect(firstPublicPackId({ items: [] })).toBeNull();
    expect(firstPublicPackId({ error: "Not Found" })).toBeNull();
    expect(firstTemplateId({ templates: [{ id: "tpl" }] })).toBe("tpl");
    expect(firstTemplateId({ templates: [] })).toBeNull();
    expect(firstStarterId({ items: [{ id: "starter" }] })).toBe("starter");
    expect(firstStarterId(undefined)).toBeNull();
  });

  test("add the template detail page and its preview when enabled", () => {
    const targets = buildTargets({
      publicIds: { packId: "pack one", templateId: "tpl", starterId: "s" },
      publicKnowledge: "enabled",
      toolEntry: "tool",
    });
    const paths = targets.map((target) => target.path);
    expect(paths).toContain(
      "/api/v1/public/knowledge/template-packs/pack%20one/templates/tpl/preview",
    );
    expect(paths).toContain("/api/v1/public/knowledge/playbook-starters/s");
    expect(
      targets
        .filter((target) => target.robots === true)
        .map((target) => target.path)
        .toSorted(),
    ).toEqual([
      "/knowledge/templates/catalogue/pack%20one/tpl",
      "/knowledge/tools/contribute",
      "/knowledge/tools/tool",
    ]);
    const member = targets.filter(
      (target) => target.responseClass === RESPONSE_CLASS.memberJson,
    );
    expect(member).toHaveLength(5);
    expect(
      member.find((target) => target.path === "/api/v1/skills/")?.cacheControl,
    ).toBe(MEMBER_JSON_CACHE_CONTROL);
  });

  test("keep every class and no robots check when disabled", () => {
    const targets = buildTargets({
      publicIds: null,
      publicKnowledge: "disabled",
      toolEntry: "tool",
    });
    const classes = new Set(targets.map((target) => target.responseClass));
    expect(classes).toEqual(
      new Set([
        RESPONSE_CLASS.page,
        RESPONSE_CLASS.accountPage,
        RESPONSE_CLASS.publicJson,
        RESPONSE_CLASS.memberJson,
      ]),
    );
    expect(targets.some((target) => target.robots === true)).toBe(false);
    expect(
      targets.some((target) => target.path.includes("/templates/catalogue/")),
    ).toBe(false);
  });
});
