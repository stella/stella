/**
 * Conversion round-trip tests for block-level SDTs.
 *
 * Parses a body containing a block w:sdt, converts to ProseMirror, back to
 * the model, then asserts the SDT properties + raw sdtPr round-trip through
 * the PM layer.
 */

import { describe, expect, test } from "bun:test";

import { parseBlockContent } from "../../docx/blockContentParser";
import { parseXml } from "../../docx/xmlParser";
import type {
  BlockContent,
  BlockSdt,
  DocumentBody,
} from "../../types/document";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';

function parseBody(xml: string): BlockContent[] {
  const root = parseXml(xml);
  const body = root.elements?.[0];
  if (!body) {
    throw new Error("expected body root");
  }
  return parseBlockContent(body, null, null, null, null, null);
}

function asDocument(content: BlockContent[]) {
  return {
    package: {
      document: { content } satisfies DocumentBody,
    },
  };
}

function expectBlockSdt(block: BlockContent | undefined): BlockSdt {
  if (!block || block.type !== "blockSdt") {
    throw new Error(`expected blockSdt, got ${String(block?.type)}`);
  }
  return block;
}

describe("toProseDoc/fromProseDoc — blockSdt round-trip", () => {
  test("emits a blockSdt PM node and recovers the BlockSdt model unchanged", () => {
    const content = parseBody(`<w:body ${NS}>
      <w:sdt>
        <w:sdtPr>
          <w:tag w:val="effective-date"/>
          <w:alias w:val="Effective Date"/>
          <w:dataBinding w:xpath="/contract/effective" w:storeItemID="{ABC}"/>
        </w:sdtPr>
        <w:sdtContent>
          <w:p><w:r><w:t>2 June 2026</w:t></w:r></w:p>
        </w:sdtContent>
      </w:sdt>
    </w:body>`);

    const pmDoc = toProseDoc(asDocument(content));
    // First child is the blockSdt node, followed by an idempotent trailing
    // paragraph (PM-side caret slot).
    expect(pmDoc.firstChild?.type.name).toBe("blockSdt");
    expect(pmDoc.firstChild?.attrs["tag"]).toBe("effective-date");
    expect(pmDoc.firstChild?.attrs["alias"]).toBe("Effective Date");
    expect(typeof pmDoc.firstChild?.attrs["rawPropertiesXml"]).toBe("string");

    const recovered = fromProseDoc(pmDoc);
    const recoveredSdt = expectBlockSdt(recovered.package.document.content[0]);
    expect(recoveredSdt.properties.tag).toBe("effective-date");
    expect(recoveredSdt.properties.alias).toBe("Effective Date");
    // Unmodeled w:dataBinding survives because rawPropertiesXml round-trips.
    expect(recoveredSdt.properties.rawPropertiesXml).toContain("w:dataBinding");
  });

  test("guarantees a trailing paragraph after a doc-final blockSdt (idempotent)", () => {
    const content = parseBody(`<w:body ${NS}>
      <w:sdt>
        <w:sdtPr><w:tag w:val="closing"/></w:sdtPr>
        <w:sdtContent><w:p/></w:sdtContent>
      </w:sdt>
    </w:body>`);

    const pmDoc = toProseDoc(asDocument(content));
    expect(pmDoc.childCount).toBe(2);
    expect(pmDoc.child(0).type.name).toBe("blockSdt");
    expect(pmDoc.child(1).type.name).toBe("paragraph");
    expect(pmDoc.child(1).content.size).toBe(0);

    // Round-trip the recovered doc again: the trailing paragraph should NOT
    // accrete a second time (idempotence).
    const recovered = fromProseDoc(pmDoc);
    const pmDoc2 = toProseDoc(recovered);
    // recovered.content has [blockSdt, paragraph]; the new pmDoc keeps that
    // shape — no extra trailing paragraph added.
    expect(pmDoc2.childCount).toBe(2);
  });

  test("preserves nested block SDTs through the PM layer", () => {
    const content = parseBody(`<w:body ${NS}>
      <w:sdt>
        <w:sdtPr><w:tag w:val="outer"/></w:sdtPr>
        <w:sdtContent>
          <w:sdt>
            <w:sdtPr><w:tag w:val="inner"/></w:sdtPr>
            <w:sdtContent>
              <w:p><w:r><w:t>inner</w:t></w:r></w:p>
            </w:sdtContent>
          </w:sdt>
        </w:sdtContent>
      </w:sdt>
    </w:body>`);

    const pmDoc = toProseDoc(asDocument(content));
    const recovered = fromProseDoc(pmDoc);
    const outer = expectBlockSdt(recovered.package.document.content[0]);
    expect(outer.properties.tag).toBe("outer");
    const inner = expectBlockSdt(outer.content[0]);
    expect(inner.properties.tag).toBe("inner");
  });
});
