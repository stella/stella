import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseXmlDocument } from "./soap.js";

// Captured from the two-pass reader this one replaced (strict validation,
// then a lenient object builder): the SOAP Body each recorded envelope
// fixture and each hand-written edge envelope parsed to, once per set of
// repeated elements the entity checks pass.
type GoldenCase = {
  name: string;
  xml?: string;
  repeated: string[];
  body: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isGoldenCase = (value: unknown): value is GoldenCase =>
  isRecord(value) &&
  typeof value["name"] === "string" &&
  Array.isArray(value["repeated"]) &&
  value["repeated"].every((name) => typeof name === "string") &&
  "body" in value;

const golden: unknown = await Bun.file(
  new URL("__fixtures__/soap-body-golden.json", import.meta.url),
).json();
if (
  !isRecord(golden) ||
  !Array.isArray(golden["fixtures"]) ||
  !Array.isArray(golden["edges"])
) {
  panic("SOAP body golden has an invalid shape");
}
const fixtureCases = golden["fixtures"].filter(isGoldenCase);
const edgeCases = golden["edges"].filter(isGoldenCase);

const packageSourceRoot = path.resolve(import.meta.dir, "..");

/**
 * The one deliberate difference: a character reference is decoded, as XML
 * requires, where the earlier builder kept `&#66;` as literal text.
 */
const DECODED_REFERENCES: Readonly<Record<string, unknown>> = {
  "numeric references": { r: { "#text": "BC", "@a": "A" } },
};

const bodyOf = (xml: string, repeated: readonly string[]): unknown => {
  const parsed = parseXmlDocument(xml, new Set(repeated));
  if (parsed.status !== "parsed") {
    return "malformed";
  }
  const envelope = parsed.document["Envelope"];
  return isRecord(envelope) ? (envelope["Body"] ?? null) : null;
};

describe("SOAP body shape", () => {
  test(`every recorded envelope fixture reads as before (${fixtureCases.length})`, async () => {
    expect(fixtureCases.length).toBeGreaterThan(20);
    for (const { name, repeated, body } of fixtureCases) {
      const xml = await Bun.file(path.join(packageSourceRoot, name)).text();
      expect({ name, repeated, body: bodyOf(xml, repeated) }).toEqual({
        name,
        repeated,
        body,
      });
    }
  });

  test(`every edge envelope reads as before (${edgeCases.length})`, () => {
    expect(edgeCases.length).toBeGreaterThan(80);
    for (const { name, xml, repeated, body } of edgeCases) {
      if (xml === undefined) {
        panic(`edge case ${name} has no XML`);
      }
      const expected = Object.hasOwn(DECODED_REFERENCES, name)
        ? DECODED_REFERENCES[name]
        : body;
      expect({ name, repeated, body: bodyOf(xml, repeated) }).toEqual({
        name,
        repeated,
        body: expected,
      });
    }
  });

  test("a truncated or mismatched response is refused, not read as far as it goes", () => {
    for (const xml of [
      "<Envelope><Body><r>1</r></Body>",
      "<Envelope><Body><r>1</Body></r></Envelope>",
      "<Envelope><Body><r>&nbsp;</r></Body></Envelope>",
      "<Envelope><Body><r a=1/></Body></Envelope>",
    ]) {
      expect(parseXmlDocument(xml, new Set()).status).toBe("malformed");
    }
  });
});
