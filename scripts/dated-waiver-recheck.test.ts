import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { NoLlmsTxtExclusion } from "../.claude/mcp/doc-sources";
import {
  applyDocRechecks,
  CHECKLIST_FILE,
  publishRecheck,
  recheckDoc,
  RECHECK_BRANCH,
  RECHECK_TITLE,
  reconcileRecheckPr,
  renderRecheckBody,
  type RecheckPr,
} from "./dated-waiver-recheck";
import { collectWaivers, type DatedWaiver } from "./dated-waivers";

const entry = {
  dependency: "example",
  checkedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-10-01T00:00:00.000Z",
  reason: "no-llms-txt",
  explanation: "https://example.com/llms.txt returns 404. Use the README.",
} as const satisfies NoLlmsTxtExclusion;
const now = new Date("2026-09-29T12:34:56.000Z");
const waiver = {
  source: ".claude/mcp/doc-sources.ts",
  line: 15,
  id: "example",
  kind: "no-llms-txt",
  expiresAt: entry.expiresAt,
  checkedAt: entry.checkedAt,
} as const satisfies DatedWaiver;
const source = `export const DOC_SOURCES = {} as const satisfies Record<string, DocSource>;
export const DOC_SOURCE_EXCLUSIONS = [].concat({
  checkedAt: "2026-09-01T00:00:00.000Z",
  dependency: "example",
  explanation: "https://example.com/llms.txt returns 404. Use the README.",
  expiresAt: "2026-10-01T00:00:00.000Z",
  reason: "no-llms-txt",
}, {
  checkedAt: "2026-09-02T00:00:00.000Z",
  dependency: "other",
  explanation: "Other fixture reference.",
  expiresAt: "2026-10-02T00:00:00.000Z",
  reason: "no-llms-txt",
});`;

const declarations = (
  content: string,
): {
  sources: Record<string, { dependencies: string[]; url: string }>;
  exclusions: NoLlmsTxtExclusion[];
} => {
  const directory = mkdtempSync(path.join(tmpdir(), "dated-waiver-fixture-"));
  try {
    const file = path.join(directory, "fixture.mjs");
    const emitted = ts.transpileModule(content, {
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    }).outputText;
    writeFileSync(
      file,
      `${emitted}\nconsole.log(JSON.stringify({ sources: DOC_SOURCES, exclusions: DOC_SOURCE_EXCLUSIONS }));`,
    );
    const result = Bun.spawnSync(["bun", "--no-env-file", file]);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("documentation rechecks", () => {
  test("404 renews the existing window and updates only the matching typed exclusion", async () => {
    const decision = await recheckDoc({
      entry,
      now,
      probe: async (url) => {
        expect(url).toBe("https://example.com/llms.txt");
        return 404;
      },
    });
    expect(decision).toEqual({
      status: "renewed",
      dependency: "example",
      checkedAt: "2026-09-29T00:00:00.000Z",
      expiresAt: "2026-10-29T00:00:00.000Z",
    });
    const before = declarations(source);
    const after = declarations(applyDocRechecks(source, [decision]));
    expect(after.exclusions.at(0)).toEqual({
      ...before.exclusions.at(0),
      checkedAt: "2026-09-29T00:00:00.000Z",
      expiresAt: "2026-10-29T00:00:00.000Z",
    });
    expect(after.exclusions.at(1)).toEqual(before.exclusions.at(1));
    expect(after.sources).toEqual({});
    expect(renderRecheckBody([waiver], [decision])).toContain(
      "proposed renewal through 2026-10-29",
    );
  });

  test("200 registers documentation and removes exactly that exclusion, including the last argument", async () => {
    for (const dependency of ["example", "other"]) {
      const decision = await recheckDoc({
        entry: { ...entry, dependency },
        now,
        probe: async () => 200,
      });
      const after = declarations(applyDocRechecks(source, [decision]));
      expect(
        after.exclusions.map((value: NoLlmsTxtExclusion) => value.dependency),
      ).toEqual(dependency === "example" ? ["other"] : ["example"]);
      expect(after.sources[dependency]).toEqual({
        dependencies: [dependency],
        url: "https://example.com/llms.txt",
      });
      expect(
        renderRecheckBody([{ ...waiver, id: dependency }], [decision]),
      ).toContain("proposed source registration");
    }
  });

  test("network failures, other statuses and absent URLs leave source unchanged and require review", async () => {
    const cases = [
      {
        entry,
        probe: async (): Promise<number> => {
          throw new TypeError("network unavailable");
        },
        detail: "Fetch failed",
      },
      { entry, probe: async () => 503, detail: "HTTP 503" },
      {
        entry: { ...entry, explanation: "No endpoint recorded." },
        probe: async (): Promise<number> => {
          throw new TypeError("must not fetch");
        },
        detail: "No llms.txt URL recorded",
      },
    ];
    for (const fixture of cases) {
      const decision = await recheckDoc({
        entry: fixture.entry,
        now,
        probe: fixture.probe,
      });
      expect(decision.status).toBe("manual");
      expect(applyDocRechecks(source, [decision])).toBe(source);
      expect(renderRecheckBody([waiver], [decision])).toContain(fixture.detail);
    }
  });

  test("batch edits retain valid source when all explicit exclusions become available", () => {
    const decisions = ["example", "other"].map(
      (dependency) =>
        ({
          status: "available",
          dependency,
          url: "https://example.com/llms.txt",
        }) as const,
    );
    const after = declarations(applyDocRechecks(source, decisions));
    expect(after.exclusions).toEqual([]);
    expect(Object.keys(after.sources).toSorted()).toEqual(["example", "other"]);
  });

  test("date-only audit deadlines render the owner-written day", () => {
    const acceptance = collectWaivers({
      read: (file) =>
        file === "scripts/dependency-audit-baseline.json"
          ? '{"id":"GHSA-fixture","expiresOn":"2026-10-03"}'
          : '{"waivers":[]}',
      docs: [],
      audit: [
        { id: "GHSA-fixture", package: "fixture", expiresOn: "2026-10-03" },
      ],
      bunfigs: [],
      releaseAgeSources: {},
    });
    const body = renderRecheckBody(acceptance, []);
    expect(acceptance).toHaveLength(1);
    expect(body).toContain("expires 2026-10-03:");
    expect(body).not.toContain("expires 2026-10-04");
  });

  test("every due kind renders an unchecked review item with its original expiry and instruction", () => {
    const kinds = [
      "no-llms-txt",
      "release-age-exclusion",
      "release-age-exception",
      "dependency-audit",
      "suppression-waiver",
    ] as const;
    const body = renderRecheckBody(
      kinds.map((kind) => ({ ...waiver, kind })),
      [],
    );
    expect(
      body.split("\n").filter((line) => line.startsWith("- [ ]")),
    ).toHaveLength(kinds.length);
    for (const kind of kinds) {
      expect(body).toContain(
        `:15\` · ${kind} · \`example\` · expires ${entry.expiresAt.slice(0, 10)}`,
      );
    }
    expect(body).toContain("Re-run the dependency audit");
    expect(body).toContain("Recheck the suppression invariant");
  });
});

describe("one recheck PR", () => {
  test("repeated reconciliation creates once, updates in place and skips identical updates", async () => {
    const open: RecheckPr[] = [];
    const operations: string[] = [];
    const github = {
      list: async () => open,
      create: async (body: string) => {
        operations.push("create");
        open.push({ number: 42, body, title: RECHECK_TITLE });
        return 42;
      },
      update: async (number: number, body: string) => {
        operations.push(`update ${number}`);
        const pr = open.at(0);
        if (!pr) {
          throw new TypeError("Fixture PR absent");
        }
        pr.body = body;
        pr.title = RECHECK_TITLE;
      },
    };
    for (const body of ["initial", "initial", "rechecked", "rechecked"]) {
      expect(await reconcileRecheckPr({ body, github })).toBe(42);
    }
    expect(operations).toEqual(["create", "update 42"]);
    expect(open).toHaveLength(1);
  });

  test("a failed PR update propagates and a later run updates the same PR", async () => {
    const pr = { number: 42, body: "old", title: "old title" };
    let failuresRemaining = 1;
    let creates = 0;
    const github = {
      list: async () => [pr],
      create: async () => ++creates,
      update: async (_number: number, body: string) => {
        if (failuresRemaining-- > 0) {
          throw new TypeError("GitHub update unavailable");
        }
        pr.body = body;
        pr.title = RECHECK_TITLE;
      },
    };
    expect(
      await rejectionOf(reconcileRecheckPr({ body: "new", github })),
    ).toMatchObject({
      message: expect.stringContaining("GitHub update unavailable"),
    });
    expect(pr.body).toBe("old");
    expect(await reconcileRecheckPr({ body: "new", github })).toBe(42);
    expect(pr.body).toBe("new");
    expect(creates).toBe(0);
  });

  test("failed signed commits leave the proposal head and PR untouched", async () => {
    const writes: string[] = [];
    const request = async (
      args: readonly string[],
      input?: unknown,
    ): Promise<unknown> => {
      const endpoint = args.at(0) ?? "";
      if (input !== undefined) {
        writes.push(endpoint);
      }
      if (endpoint.endsWith("/pulls")) {
        return [];
      }
      if (endpoint.endsWith("/git/ref/heads/main")) {
        return { object: { sha: "base-sha" } };
      }
      if (endpoint.includes("/git/matching-refs/")) {
        return [];
      }
      if (endpoint.endsWith("/git/refs")) {
        return {};
      }
      if (endpoint === "graphql") {
        return { errors: [{ message: "Expected head changed" }] };
      }
      throw new TypeError(`Unexpected GitHub call: ${endpoint}`);
    };
    expect(
      await rejectionOf(
        publishRecheck({
          baseSha: "base-sha",
          body: "checklist",
          files: { [CHECKLIST_FILE]: "checklist" },
          repo: "stella/stella",
          request,
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("GitHub signed commit failed"),
    });
    expect(writes).toEqual(["repos/stella/stella/git/refs", "graphql"]);
  });

  test("ambiguous open PRs fail before making any write", async () => {
    let writes = 0;
    expect(
      await rejectionOf(
        reconcileRecheckPr({
          body: "new",
          github: {
            list: async () => [
              { number: 1, body: "", title: "" },
              { number: 2, body: "", title: "" },
            ],
            create: async () => ++writes,
            update: async () => {
              writes++;
            },
          },
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("Multiple open dated-waiver"),
    });
    expect(writes).toBe(0);
  });

  test("publication retains the checkout base when main advances its documentation registry", async () => {
    const checkoutSha = "checkout-sha";
    const generatedRegistry = applyDocRechecks(source, [
      {
        status: "renewed",
        dependency: "example",
        checkedAt: "2026-09-29T00:00:00.000Z",
        expiresAt: "2026-10-29T00:00:00.000Z",
      },
    ]);
    const files = {
      [CHECKLIST_FILE]: "checklist",
      ".claude/mcp/doc-sources.ts": generatedRegistry,
    };
    // Main advances after this proposal's files have been generated.
    const latestMain = {
      sha: "advanced-main-sha",
      registry: source.replace(
        "DOC_SOURCES = {}",
        'DOC_SOURCES = { Added: { dependencies: ["added"], url: "https://new.example/llms.txt" } }',
      ),
    };
    expect(latestMain.registry).not.toBe(source);
    const calls: { args: readonly string[]; input: unknown }[] = [];
    const request = async (
      args: readonly string[],
      input?: unknown,
    ): Promise<unknown> => {
      calls.push({ args, input });
      const endpoint = args.at(0);
      if (endpoint === "repos/stella/stella/git/ref/heads/main") {
        return { object: { sha: latestMain.sha } };
      }
      if (endpoint === "repos/stella/stella/pulls" && args.includes("GET")) {
        return [];
      }
      if (endpoint?.includes("/git/matching-refs/")) {
        return [];
      }
      if (endpoint === "repos/stella/stella/git/refs") {
        return {};
      }
      if (endpoint === "graphql") {
        expect(input).toMatchObject({
          variables: {
            input: {
              expectedHeadOid: checkoutSha,
              fileChanges: {
                additions: [
                  {
                    path: CHECKLIST_FILE,
                    contents: Buffer.from("checklist").toString("base64"),
                  },
                  {
                    path: ".claude/mcp/doc-sources.ts",
                    contents: Buffer.from(generatedRegistry).toString("base64"),
                  },
                ],
              },
            },
          },
        });
        return {
          data: { createCommitOnBranch: { commit: { oid: "signed-sha" } } },
        };
      }
      if (endpoint?.includes("/git/refs/heads/")) {
        return null;
      }
      if (endpoint === "repos/stella/stella/pulls" && args.includes("POST")) {
        return { number: 42 };
      }
      throw new TypeError(`Unexpected GitHub call: ${args.join(" ")}`);
    };
    expect(
      await publishRecheck({
        baseSha: checkoutSha,
        body: "checklist",
        files,
        repo: "stella/stella",
        request,
      }),
    ).toBe(42);
    expect(
      calls.find(({ args }) => args.at(0) === "repos/stella/stella/git/refs")
        ?.input,
    ).toEqual({ ref: `refs/heads/${RECHECK_BRANCH}-next`, sha: checkoutSha });
    expect(
      calls.some(
        ({ args }) => args.at(0) === "repos/stella/stella/git/ref/heads/main",
      ),
    ).toBe(false);
    expect(latestMain.registry).toContain('dependencies: ["added"]');
  });

  test("signed GitHub publishing creates one draft PR and makes no writes on an identical rerun", async () => {
    const files = {
      [CHECKLIST_FILE]: "checklist",
      ".claude/mcp/doc-sources.ts": source,
    };
    const open: RecheckPr[] = [];
    const refs = new Set<string>();
    const calls: { args: readonly string[]; input: unknown }[] = [];
    const request = async (
      args: readonly string[],
      input?: unknown,
    ): Promise<unknown> => {
      calls.push({ args, input });
      const endpoint = args.at(0);
      if (endpoint === "repos/stella/stella/pulls" && args.includes("GET")) {
        return open;
      }
      if (endpoint?.includes("/contents/")) {
        const file = endpoint.split("/contents/").at(1);
        if (!file || !(file in files)) {
          throw new TypeError("Unexpected fixture file");
        }
        return {
          content: Buffer.from(Reflect.get(files, file)).toString("base64"),
        };
      }
      if (endpoint === "repos/stella/stella/git/ref/heads/main") {
        return { object: { sha: "base-sha" } };
      }
      if (endpoint?.includes("/git/matching-refs/heads/")) {
        const branch = endpoint.split("/heads/").at(1);
        return refs.has(branch ?? "") ? [{ ref: `refs/heads/${branch}` }] : [];
      }
      if (
        endpoint === "repos/stella/stella/git/refs" &&
        input &&
        typeof input === "object" &&
        "ref" in input &&
        typeof input.ref === "string"
      ) {
        refs.add(input.ref.replace("refs/heads/", ""));
        return {};
      }
      if (endpoint === "graphql") {
        return {
          data: { createCommitOnBranch: { commit: { oid: "signed-sha" } } },
        };
      }
      if (endpoint?.includes("/git/refs/heads/")) {
        return null;
      }
      if (
        endpoint === "repos/stella/stella/pulls" &&
        input &&
        typeof input === "object" &&
        "body" in input &&
        typeof input.body === "string"
      ) {
        open.push({ number: 42, title: RECHECK_TITLE, body: input.body });
        return { number: 42 };
      }
      throw new TypeError(`Unexpected GitHub call: ${args.join(" ")}`);
    };
    expect(
      await publishRecheck({
        baseSha: "base-sha",
        body: "checklist",
        files,
        repo: "stella/stella",
        request,
      }),
    ).toBe(42);
    const writes = calls.filter(({ input }) => input !== undefined);
    expect(
      writes.find(({ args }) => args.at(0) === "repos/stella/stella/pulls")
        ?.input,
    ).toEqual({
      head: RECHECK_BRANCH,
      base: "main",
      title: RECHECK_TITLE,
      body: "checklist",
      draft: true,
    });
    expect(
      writes.find(({ args }) => args.at(0) === "graphql")?.input,
    ).toMatchObject({
      variables: {
        input: {
          expectedHeadOid: "base-sha",
          branch: { branchName: `${RECHECK_BRANCH}-next` },
        },
      },
    });
    calls.length = 0;
    expect(
      await publishRecheck({
        baseSha: "base-sha",
        body: "checklist",
        files,
        repo: "stella/stella",
        request,
      }),
    ).toBe(42);
    expect(
      calls.every(
        ({ input, args }) => input === undefined && !args.includes("DELETE"),
      ),
    ).toBe(true);
    expect(open).toHaveLength(1);
  });
});
