/**
 * Census: stored DOCX bytes never carry a stella document reference.
 *
 * No single module owns object placement for a document version, so the
 * disposition map is the register and this test holds it to the source. The
 * map is total over `REVIEWED_VERSION_MUTATION_OWNERS`, so a new version-write
 * owner is a type error until it declares a disposition; this test then makes
 * the declaration mean something: a `strips-reference` owner must call
 * `storedDocumentBytes`, an owner that declared otherwise must not, and a
 * module that calls it without being declared fails too.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  DOCUMENT_BYTE_WRITE_DISPOSITION,
  STORED_BYTE_DISPOSITION,
} from "@/api/lib/entity-versions/docx-strip-ownership-policy";

// apps/api/src, three levels up from apps/api/src/lib/entity-versions.
const API_SRC = path.resolve(import.meta.dir, "../..");

/** The owner module itself, which defines the helper rather than calling it. */
const OWNER_MODULE = "lib/files/stored-document-bytes.ts";

const CALL_SITE_RE = /\bstoredDocumentBytes\(/u;

const sourceOf = async (module: string): Promise<string> =>
  await Bun.file(path.join(API_SRC, module)).text();

const callSites = async (): Promise<string[]> => {
  const matched: string[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: API_SRC })) {
    if (file.includes(".test.") || file === OWNER_MODULE) {
      continue;
    }
    if (CALL_SITE_RE.test(await sourceOf(file))) {
      matched.push(file);
    }
  }
  return matched.sort();
};

describe("document-reference stripping has declared owners", () => {
  for (const [module, disposition] of Object.entries(
    DOCUMENT_BYTE_WRITE_DISPOSITION,
  )) {
    const shouldStrip =
      disposition === STORED_BYTE_DISPOSITION.STRIPS_REFERENCE;

    test(`${module} is ${disposition}`, async () => {
      expect(CALL_SITE_RE.test(await sourceOf(module))).toBe(shouldStrip);
    });
  }

  test("no undeclared module strips document references", async () => {
    const declared = Object.entries(DOCUMENT_BYTE_WRITE_DISPOSITION)
      .filter(
        ([, disposition]) =>
          disposition === STORED_BYTE_DISPOSITION.STRIPS_REFERENCE,
      )
      .map(([module]) => module)
      .sort();

    expect(await callSites()).toEqual(declared);
  });
});
