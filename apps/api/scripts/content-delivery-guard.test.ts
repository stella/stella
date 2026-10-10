import { describe, expect, test } from "bun:test";

import {
  analyzeContentDelivery,
  discoveryFailures,
} from "./content-delivery-guard";

const analyze = (sources: Record<string, string>) =>
  analyzeContentDelivery({
    files: ["/routes.ts"],
    readFile: (file) => sources[file],
    resolveImport: (specifier) => {
      if (specifier.startsWith(".")) {
        return `/${specifier.slice(2)}.ts`;
      }
      if (specifier.startsWith("@/api/lib/")) {
        return `/apps/api/src/lib/${specifier.slice(10)}.ts`;
      }
      return undefined;
    },
  });

describe("content delivery declarations follow reachable runtime definitions", () => {
  test("treats explicitly imported text assets as inert values", () => {
    const result = analyze({
      "/routes.ts":
        'import asset from "./runtime.js.txt" with { type: "text" }; export default createSafeHandler({}, () => new Response(asset));',
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  test.each([
    'import { readS3ArrayBuffer } from "@/api/lib/s3"; export default createSafeHandler({}, () => readS3ArrayBuffer("key"));',
    'import { readS3ArrayBuffer as read } from "@/api/lib/s3"; export const endpoint = createSafeHandler({}, () => read("key"));',
    'import * as store from "@/api/lib/s3"; export default createSafeHandler({}, () => store.readS3ArrayBuffer("key"));',
    'export default createSafeHandler({}, () => new Response("bytes", { headers: { "Content-Disposition": "attachment" } }));',
    'export default createSafeHandler({}, ({ set }) => { set.headers["content-disposition"] = "attachment"; return "bytes"; });',
    'export default createSafeHandler({}, () => { const headers = new Headers(); headers.set("Content-Disposition", "attachment"); return new Response("bytes", { headers }); });',
  ])("detects undeclared byte or signed URL delivery: %s", (source) => {
    const result = analyze({ "/routes.ts": source });
    expect(result.errors).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates.at(0)?.declared).toBe(false);
  });

  test.each([
    'import { getS3 } from "@/api/lib/s3"; export default createSafeHandler({}, () => getS3().presign("key"));',
    'import { getS3 } from "@/api/lib/s3"; export default createSafeHandler({}, () => { const store = getS3(); return store.presign("key", { expiresIn: 60 }); });',
  ])("detects undeclared presigning on an S3 owner store: %s", (source) => {
    const result = analyze({
      "/routes.ts": source,
      "/apps/api/src/lib/s3.ts": "export const getS3 = () => client;",
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates.at(0)?.terminals).toEqual(["presign"]);
    expect(result.candidates.at(0)?.declared).toBe(false);
  });

  test("follows named and star reexports, aliases, and injected readers", () => {
    const result = analyze({
      "/routes.ts":
        'import { deliver as wrapped } from "./barrel"; import { readS3ObjectBounded as readObject } from "@/api/lib/s3"; const helper = () => wrapped({ read: readObject }); export const route = createSafeHandler({ contentDelivery: { type: "audited" } }, helper);',
      "/barrel.ts": 'export * from "./wrapper";',
      "/wrapper.ts": 'export { serve as deliver } from "./owner";',
      "/owner.ts": 'export const serve = ({ read }) => read("key");',
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates.at(0)?.terminals).toEqual(["readS3ObjectBounded"]);
    expect(result.candidates.at(0)?.declared).toBe(true);
  });

  test("follows default imports and local function declarations", () => {
    const result = analyze({
      "/routes.ts":
        'import deliver from "./helper"; function callback() { return deliver(); } export default createSafeHandler({}, callback);',
      "/helper.ts":
        'import { auditedPresignDownload as sign } from "@/api/lib/audited-download"; export default function deliver() { return sign("key"); }',
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates.at(0)?.terminals).toEqual([
      "auditedPresignDownload",
    ]);
  });

  test.each([
    'function deliver() { return read("key"); } return deliver();',
    'const deliver = () => read("key"); return deliver();',
  ])("follows callback-local helpers after their declarations: %s", (body) => {
    const result = analyze({
      "/routes.ts": `import { readS3ArrayBuffer as read } from "@/api/lib/s3"; export default createSafeHandler({}, () => { ${body} });`,
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates.at(0)?.terminals).toEqual(["readS3ArrayBuffer"]);
  });

  test("follows raw reader aliases through named and star reexports", () => {
    const result = analyze({
      "/routes.ts":
        'import { read } from "./barrel"; export default createSafeHandler({}, () => read("key"));',
      "/barrel.ts": 'export * from "./reader";',
      "/reader.ts": 'export { readS3ArrayBuffer as read } from "@/api/lib/s3";',
      "/apps/api/src/lib/s3.ts":
        'export const readS3ArrayBuffer = () => "bytes";',
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates.at(0)?.terminals).toEqual(["readS3ArrayBuffer"]);
  });

  test("follows static dynamic imports to the runtime member", () => {
    const result = analyze({
      "/routes.ts":
        'export default createSafeHandler({}, async () => (await import("./helper")).deliver());',
      "/helper.ts":
        'import { secureDocumentResponse } from "@/api/lib/secure-document-response"; export const deliver = () => secureDocumentResponse("bytes");',
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates.at(0)?.terminals).toEqual([
      "secureDocumentResponse",
    ]);
  });

  test.each(['store[member]("key")', "helper(store)"])(
    "fails inspection for a local namespace without a resolved member: %s",
    (expression) => {
      const result = analyze({
        "/routes.ts": `import * as store from "./store"; export default createSafeHandler({}, () => ${expression});`,
      });
      expect(result.errors).toContain(
        "Unresolved namespace member store in /routes.ts",
      );
    },
  );

  test.each([
    'import { createSafeHandler as safe } from "factory"; export default safe({}, () => "metadata");',
    'import { createSafeHandler } from "factory"; const safe = createSafeHandler; export default safe({}, () => "metadata");',
  ])(
    "fails inspection when a factory alias escapes the shared discovery prefilter",
    (source) => {
      expect(analyze({ "/routes.ts": source }).errors).toContain(
        "Aliased safe factory cannot be enumerated in /routes.ts",
      );
    },
  );

  test("dynamic destructuring follows the selected export only", () => {
    const result = analyze({
      "/routes.ts":
        'export default createSafeHandler({}, async () => { const { metadata } = await import("./helper"); return metadata(); });',
      "/helper.ts":
        'import { readS3ArrayBuffer } from "@/api/lib/s3"; export const metadata = () => "metadata"; export const bytes = () => readS3ArrayBuffer("key");',
    });
    expect(result).toEqual({ candidates: [], errors: [] });
  });

  test("fails inspection for an unselected dynamic namespace of reexports", () => {
    const result = analyze({
      "/routes.ts":
        'export default createSafeHandler({}, async () => helper(await import("./barrel")));',
      "/barrel.ts": 'export * from "@/api/lib/s3";',
    });
    expect(result.errors).toContain(
      "Unresolved dynamic namespace re-export in /barrel.ts",
    );
  });

  test("unrelated function names do not imply stored byte delivery", () => {
    expect(
      analyze({
        "/routes.ts":
          'import { readS3ArrayBuffer } from "./helper"; export default createSafeHandler({}, () => readS3ArrayBuffer());',
        "/helper.ts": 'export const readS3ArrayBuffer = () => "metadata";',
      }),
    ).toEqual({ candidates: [], errors: [] });
  });

  test("a presign method on a store outside the S3 owner is not delivery", () => {
    expect(
      analyze({
        "/routes.ts":
          'import { signer } from "./helper"; export default createSafeHandler({}, () => signer().presign("key"));',
        "/helper.ts":
          "export const signer = () => ({ presign: (key) => key });",
      }),
    ).toEqual({ candidates: [], errors: [] });
  });

  test("reading a disposition header does not declare response delivery", () => {
    expect(
      analyze({
        "/routes.ts":
          'export default createSafeHandler({}, ({ request }) => request.headers.get("Content-Disposition"));',
      }),
    ).toEqual({ candidates: [], errors: [] });
  });

  test.each([
    ['{ type: "audited" }', true],
    ['{ type: "public", reason: "Published file" }', true],
    ['{ type: "none", reason: "Internal processing" }', true],
    ['{ type: "public", reason: " " }', false],
    ['{ type: "none" }', false],
    ['{ type: "unknown" }', false],
  ])(
    "validates declared dispositions through config identifiers: %s",
    (delivery, declared) => {
      const result = analyze({
        "/routes.ts": `import { readS3ArrayBuffer as read } from "@/api/lib/s3"; const config = { contentDelivery: ${delivery} } as const satisfies Config; export default createSafeHandler(config, () => read("key"));`,
      });
      expect(result.errors).toEqual([]);
      expect(result.candidates.at(0)?.declared).toBe(declared);
    },
  );

  test("ignores unused module imports, unrelated helpers, types, and comments", () => {
    const result = analyze({
      "/routes.ts":
        'import { readS3ArrayBuffer } from "@/api/lib/s3"; import { unused } from "./missing"; const unrelated = () => readS3ArrayBuffer("key"); type Shape = typeof readS3ArrayBuffer; export default createSafeHandler({}, () => { function neverCalled() { return readS3ArrayBuffer("key"); } const alsoUnused = () => readS3ArrayBuffer("key"); return { message: "metadata" }; }); // Content-Disposition',
    });
    expect(result).toEqual({ candidates: [], errors: [] });
  });

  test.each([
    'import { deliver } from "./missing"; export default createSafeHandler({}, () => deliver());',
    'import { deliver } from "./helper"; export default createSafeHandler({}, () => deliver());',
    'export default createSafeHandler({}, async () => (await import("./helper")).deliver());',
  ])("fails inspection when a reached local edge cannot resolve", (source) => {
    expect(
      analyze({
        "/routes.ts": source,
        "/helper.ts": 'export const unrelated = () => "metadata";',
      }).errors,
    ).not.toEqual([]);
  });

  test("inspects inline and subject factory callbacks", () => {
    const result = analyze({
      "/routes.ts":
        'import { secureDocumentResponse as deliver } from "@/api/lib/secure-document-response"; app.get("/file", createSafeHandler({}, () => deliver("bytes"))); export default createSafePublicSubjectHandler({ config: { contentDelivery: { type: "public", reason: "Published file" } }, read: () => deliver("bytes") });',
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates.map(({ declared }) => declared)).toEqual([
      false,
      true,
    ]);
  });

  test("preserves module import failures", () => {
    expect(
      discoveryFailures({
        files: [],
        endpoints: [],
        routeFiles: [],
        importErrors: [{ id: "route.ts", message: "failed" }],
      }),
    ).toContain("Import failed route.ts: failed");
  });

  test("preserves hidden endpoint failures", () => {
    expect(
      discoveryFailures({
        endpoints: [],
        importErrors: [],
        routeFiles: [],
        files: [
          {
            id: "route.ts",
            callCount: 2,
            enumerableCount: 1,
            source: "",
            kinds: [],
          },
        ],
      }),
    ).toContain("Hidden endpoint in route.ts");
  });
});
