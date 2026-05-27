import { describe, expect, test } from "bun:test";

import { elementToXml, parseXmlDocument } from "./xmlParser";

describe("OOXML parsing", () => {
  test("preserves legacy inline binary payloads", () => {
    const document = parseXmlDocument(
      '<w:p xmlns:w="urn"><w:binData w:name="image1">QUJDRA==</w:binData><w:r><w:t>after</w:t></w:r></w:p>',
    );

    expect(document?.elements?.at(0)?.name).toBe("w:binData");
    expect(document?.elements?.at(0)?.elements?.at(0)?.text).toBe("QUJDRA==");
    expect(document?.elements?.at(1)?.name).toBe("w:r");
    expect(document ? elementToXml(document) : "").toContain(
      '<w:binData w:name="image1">QUJDRA==</w:binData>',
    );
  });
});
