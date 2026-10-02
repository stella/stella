import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { TOOL_ANNOTATIONS } from "./annotations.js";
import { generatedRouteMap } from "./generated/route-map.js";
import {
  describeLimit,
  localFileLimits,
  readLocalFileAsBase64,
} from "./local-file-flag.js";
import type { JsonSchema, RouteNode } from "./route-types.js";

/** `create_template`'s real ceiling: half the 512 KiB MCP request frame. */
const MAX_BASE64 = 262_144;

const schemaWithCap = (maxLength: number | undefined): JsonSchema => ({
  type: "object",
  properties: {
    docx_base64: {
      type: "string",
      ...(maxLength === undefined ? {} : { maxLength }),
    },
  },
});

const tempDirs: string[] = [];

/**
 * A .docx fixture of `bytes`. The CLI never parses the archive (the server
 * validates it), so what matters here is the size and the extension: the
 * over-cap path must refuse before any request is built.
 */
const writeDocxFixture = async (bytes: number): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "stella-docx-"));
  tempDirs.push(dir);
  const file = path.join(dir, "engagement-letter.docx");
  // "PK" so the fixture opens as the ZIP container a DOCX is.
  const content = Buffer.alloc(bytes, "a");
  content.write("PK", 0, "binary");
  await writeFile(file, content);
  return file;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("localFileLimits", () => {
  test("the ceiling is the prop's own maxLength, in characters and in bytes", () => {
    expect(
      localFileLimits({
        inputSchema: schemaWithCap(MAX_BASE64),
        prop: "docx_base64",
      }),
    ).toEqual({ maxBase64Length: MAX_BASE64, maxBytes: 196_608 });
  });

  test("a file at the byte ceiling encodes within the character ceiling", () => {
    const limits = localFileLimits({
      inputSchema: schemaWithCap(MAX_BASE64),
      prop: "docx_base64",
    });
    expect(limits).toBeDefined();
    const encodedLength = 4 * Math.ceil((limits?.maxBytes ?? 0) / 3);
    expect(encodedLength).toBeLessThanOrEqual(limits?.maxBase64Length ?? 0);
  });

  test("no declared maxLength means no locally-stated ceiling", () => {
    expect(
      localFileLimits({
        inputSchema: schemaWithCap(undefined),
        prop: "docx_base64",
      }),
    ).toBeUndefined();
    expect(
      localFileLimits({
        inputSchema: schemaWithCap(MAX_BASE64),
        prop: "missing_prop",
      }),
    ).toBeUndefined();
  });

  test("describeLimit states the cap in bytes and KB", () => {
    expect(
      describeLimit({ maxBase64Length: MAX_BASE64, maxBytes: 196_608 }),
    ).toBe("196608 bytes (192 KB)");
  });
});

/**
 * The build-time half of the invariant the generator deliberately does not
 * throw on: every `localFileBase64Prop` the API annotates must be backed by a
 * capped string in the committed snapshot. Renaming or uncapping the prop
 * without updating the annotation silently drops `--file` from the command, so
 * the committed tree is checked here instead.
 */
describe("the generated tree backs every --file it offers", () => {
  const leavesWithLocalFile = (
    node: RouteNode,
  ): Extract<RouteNode, { kind: "leaf" }>["spec"][] => {
    if (node.kind === "leaf") {
      return node.spec.localFileBase64Prop === undefined ? [] : [node.spec];
    }
    if (node.kind !== "route") {
      return [];
    }
    return Object.values(node.children).flatMap((child) =>
      leavesWithLocalFile(child),
    );
  };

  const annotated = Object.entries(TOOL_ANNOTATIONS)
    .filter(([, annotation]) => annotation.localFileBase64Prop !== undefined)
    .map(([name]) => name);

  test("every annotated tool reached the tree with a usable ceiling", () => {
    // Not vacuous: `create_template` is the tool this exists for.
    expect(annotated).toContain("create_template");
    const leaves = leavesWithLocalFile(generatedRouteMap);
    expect(
      [...new Set(leaves.map((spec) => spec.toolName))].toSorted(),
    ).toEqual(annotated.toSorted());
    for (const spec of leaves) {
      const prop = spec.localFileBase64Prop ?? "";
      expect(
        localFileLimits({ inputSchema: spec.inputSchema, prop }),
      ).toBeDefined();
    }
  });
});

describe("readLocalFileAsBase64", () => {
  const limits = localFileLimits({
    inputSchema: schemaWithCap(MAX_BASE64),
    prop: "docx_base64",
  });

  test("a file within the cap becomes the prop's base64", async () => {
    const file = await writeDocxFixture(4096);
    const result = await readLocalFileAsBase64({
      commandLabel: "stella template create",
      limits,
      path: file,
      prop: "docx_base64",
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(Buffer.from(result.value, "base64").byteLength).toBe(4096);
    }
  });

  test("a 300 KB DOCX is refused, naming the cap and the host-file route", async () => {
    const file = await writeDocxFixture(300 * 1024);
    const result = await readLocalFileAsBase64({
      commandLabel: "stella template create",
      limits,
      path: file,
      prop: "docx_base64",
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toContain("307200 bytes");
      expect(result.error).toContain("262144 base64 characters");
      expect(result.error).toContain("196608 bytes (192 KB)");
      expect(result.error).toContain("'file' reference");
      // Rule 9 of the agent-contract conventions: never invite a model to
      // rewrite a document to fit a transport.
      expect(result.error).toContain("Do not re-export or strip");
    }
  });

  test("with no declared ceiling the bytes travel and the server rules", async () => {
    const file = await writeDocxFixture(300 * 1024);
    const result = await readLocalFileAsBase64({
      commandLabel: "stella template create",
      limits: undefined,
      path: file,
      prop: "docx_base64",
    });
    expect(Result.isOk(result)).toBe(true);
  });

  test("a missing or empty file is a named failure, not an empty payload", async () => {
    const missing = await readLocalFileAsBase64({
      commandLabel: "stella template create",
      limits,
      path: path.join(tmpdir(), "stella-does-not-exist.docx"),
      prop: "docx_base64",
    });
    expect(Result.isError(missing)).toBe(true);
    if (Result.isError(missing)) {
      expect(missing.error).toContain("--file could not read");
    }

    const empty = await writeDocxFixture(0);
    const emptyResult = await readLocalFileAsBase64({
      commandLabel: "stella template create",
      limits,
      path: empty,
      prop: "docx_base64",
    });
    expect(Result.isError(emptyResult)).toBe(true);
    if (Result.isError(emptyResult)) {
      expect(emptyResult.error).toContain("is empty");
    }
  });
});
