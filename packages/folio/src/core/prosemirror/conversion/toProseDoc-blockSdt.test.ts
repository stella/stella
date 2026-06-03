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
import { schema } from "../schema";
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
    // First and only child is the blockSdt node. The caret affordance
    // after a doc-final isolating SDT is provided at runtime by
    // prosemirror-gapcursor — no synthetic paragraph is appended (it
    // would otherwise survive the reverse pass and append a stray
    // `<w:p/>` to the source DOCX on every save).
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

  test("preserves an explicit showingPlaceholder=false through the PM round-trip", () => {
    // Regression: the conversion previously preserved only `true`, so a
    // user filling a placeholder-bearing control via the widget path
    // (which writes `showingPlaceholder: false`) would round-trip with
    // `properties.showingPlaceholder = undefined`. `reconcileRawSdtPr`
    // then never saw `false` and could not strip the source
    // `<w:showingPlcHdr/>` from rawPropertiesXml, so Word reopened the
    // doc still treating the filled body as placeholder text.
    const sdt = schema.node(
      "blockSdt",
      { sdtType: "richText", tag: "name", showingPlaceholder: false },
      [schema.node("paragraph", {}, [schema.text("Real value")])],
    );
    const pmDoc = schema.node("doc", null, [sdt]);
    const recovered = fromProseDoc(pmDoc);
    const ctrl = expectBlockSdt(recovered.package.document.content[0]);
    expect(ctrl.properties.showingPlaceholder).toBe(false);
  });

  test("does not inject a synthetic trailing paragraph after a doc-final blockSdt", () => {
    // Codex P2 (PR #587): the converter previously appended an empty
    // trailing paragraph to keep the caret reachable after a doc-final
    // isolating SDT, but that paragraph survived the reverse pass and
    // appended an extra `<w:p/>` to the DOCX on every save — visible
    // blank space + pagination drift in legal templates. The caret
    // affordance is now provided by prosemirror-gapcursor at runtime, so
    // the converter emits only what the source described.
    const content = parseBody(`<w:body ${NS}>
      <w:sdt>
        <w:sdtPr><w:tag w:val="closing"/></w:sdtPr>
        <w:sdtContent><w:p/></w:sdtContent>
      </w:sdt>
    </w:body>`);

    const pmDoc = toProseDoc(asDocument(content));
    expect(pmDoc.childCount).toBe(1);
    expect(pmDoc.child(0).type.name).toBe("blockSdt");

    // Round-trip is now lossless: the recovered model has exactly one
    // top-level block (the SDT), and a second toProseDoc keeps that shape.
    const recovered = fromProseDoc(pmDoc);
    expect(recovered.package.document.content).toHaveLength(1);
    const pmDoc2 = toProseDoc(recovered);
    expect(pmDoc2.childCount).toBe(1);
  });

  test("round-trips an empty <w:sdtContent/> without adding a synthetic <w:p/>", () => {
    // Codex P2 (PR #587): toProseDoc inserts a synthetic empty paragraph
    // for any blockSdt whose source had `<w:sdtContent/>` because the
    // PM `block+` schema requires at least one child. Without the
    // fromProseDoc guard, that synthetic paragraph survived the
    // reverse pass and turned every empty control into
    // `<w:sdtContent><w:p/></w:sdtContent>` — adding content Word did
    // not emit.
    const content = parseBody(`<w:body ${NS}>
      <w:sdt>
        <w:sdtPr><w:tag w:val="empty"/></w:sdtPr>
        <w:sdtContent/>
      </w:sdt>
    </w:body>`);
    const pmDoc = toProseDoc(asDocument(content));
    expect(pmDoc.childCount).toBe(1);
    expect(pmDoc.child(0).type.name).toBe("blockSdt");
    // PM body has one filler paragraph (block+ constraint).
    expect(pmDoc.child(0).childCount).toBe(1);
    expect(pmDoc.child(0).firstChild?.type.name).toBe("paragraph");
    expect(pmDoc.child(0).firstChild?.content.size).toBe(0);

    // Round-trip: recovered model has content: [] again, and a second
    // toProseDoc gives the same PM shape (idempotent).
    const recovered = fromProseDoc(pmDoc);
    const recoveredSdt = recovered.package.document.content[0];
    if (!recoveredSdt || recoveredSdt.type !== "blockSdt") {
      throw new TypeError("expected blockSdt");
    }
    expect(recoveredSdt.content).toHaveLength(0);
    const pmDoc2 = toProseDoc(recovered);
    expect(pmDoc2.childCount).toBe(1);
    expect(pmDoc2.child(0).childCount).toBe(1);
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
