import { expect, test } from "bun:test";

import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/ingestion-types";
import { readSourceRawField } from "@/api/lib/legal-search/source-raw-field";

import { COURTLISTENER_TEXT_FORMATS } from "../../parsers/courtlistener/select";
import { courtListenerConformanceFixture } from "./conformance-fixture";
import { COURTLISTENER_SOURCE_FIELD_INVENTORY } from "./inventory";

test("every alternate rendition proves exact nonempty Unicode and control-character retention", async () => {
  const fixture = courtListenerConformanceFixture();
  const decision = await fixture.buildDecision();
  const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
  expect(parts).not.toBeNull();
  if (parts === null)
    throw new Error("Conformance fixture lost its raw envelope");
  const observed = new Set<string>();
  for (const column of [...COURTLISTENER_TEXT_FORMATS, "xml_scan"]) {
    if (column === "xml_harvard") continue;
    const field = `opinions[].${column}`;
    const values = fixture.rawFieldValues[field];
    expect(Array.isArray(values)).toBe(true);
    if (!Array.isArray(values))
      throw new Error(`Missing original value for ${field}`);
    for (const value of values) {
      expect(typeof value).toBe("string");
      if (typeof value !== "string")
        throw new Error(`Non-text fixture value for ${field}`);
      expect(value).toContain(column);
      expect(value).toMatch(/[^\x00-\x7f]/u);
      expect(value).toContain("\u0000");
      expect(value).toContain("\u200b");
      expect(observed.has(value)).toBe(false);
      observed.add(value);
    }
    const disposition = COURTLISTENER_SOURCE_FIELD_INVENTORY.fields[field];
    expect(disposition?.disposition).toBe("stored");
    if (
      disposition?.disposition !== "stored" ||
      disposition.target.type !== "raw"
    )
      throw new Error(`Missing raw-path disposition for ${field}`);
    expect(readSourceRawField(parts, disposition.target)).toEqual(values);
  }
  expect(observed.size).toBe(COURTLISTENER_TEXT_FORMATS.length);
});
