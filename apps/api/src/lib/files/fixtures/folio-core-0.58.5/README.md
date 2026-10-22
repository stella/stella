# Folio snapshot recovery fixtures

These snapshots were written by the published `@stll/folio-core@0.58.5`,
with `yjs@13.6.27`, `y-prosemirror@1.3.7`, and `prosemirror-model@1.25.9`
in an isolated scratch package. All carry attribute schema 12, written
by the old package's metadata writer. They are not synthetic version stamps.

`saved.docx` contains style-inherited numbering. The old editor records both
`numPr` and `numPrFromStyle`, which schema 13 refuses because the ownership
of the numbering override is ambiguous. `clean.yjs` represents its initial
seed; `dirty.yjs` appends an unpublished amendment. The old package
materialized both snapshots against the source and extracted the expected
saved and amended text before these bytes were committed.

`migratable.yjs` was generated from the unmodified `base.docx` using the same
conversion and metadata writer. It has no ambiguous numbering and migrates
without reseeding; it verifies that saved cuts hash the persisted input bytes
rather than a normalized update.

To reproduce, first create `base.docx` with the old package:

```ts
await Bun.write(
  "base.docx",
  await createDocx(
    createEmptyDocument({
      initialText: "Saved contract. Článek první.",
    }),
  ),
);
```

Add a paragraph style that inherits numbering using this Python script:

```py
import zipfile, re
with zipfile.ZipFile("base.docx") as z:
    parts = {name: z.read(name) for name in z.namelist()}
xml = parts["word/document.xml"].decode()
xml = re.sub(r"<w:pPr>.*?</w:pPr>", '<w:pPr><w:pStyle w:val="Numbered"/></w:pPr>', xml, count=1)
parts["word/document.xml"] = xml.encode()
style = '<w:style w:type="paragraph" w:styleId="Numbered"><w:name w:val="Numbered"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>'
parts["word/styles.xml"] = parts["word/styles.xml"].replace(b"</w:styles>", style.encode()+b"</w:styles>")
parts["word/numbering.xml"] = b'<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
parts["word/_rels/document.xml.rels"] = parts["word/_rels/document.xml.rels"].replace(b"</Relationships>", b'<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>')
parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(b"</Types>", b'<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>')
with zipfile.ZipFile("saved.docx", "w", zipfile.ZIP_DEFLATED) as z:
    for name, data in parts.items(): z.writestr(name,data)
```

Then run this TypeScript script in the same scratch package:

```ts
import { readFileSync } from "node:fs";
import { prosemirrorToYDoc } from "y-prosemirror";
import { encodeStateAsUpdate } from "yjs";

import { toProseDoc } from "@stll/folio-core/prosemirror/conversion";
import {
  createDocx,
  createEmptyDocument,
  parseDocx,
  materializeYjsDocx,
  extractDocxText,
} from "@stll/folio-core/server";

import { writeYjsDocumentMetadata } from "./node_modules/@stll/folio-core/dist/prosemirror/yjsDocumentMetadata.js";
const source = new Uint8Array(readFileSync("saved.docx"));
await Bun.write("saved.docx", source);
for (const [name, dirty] of [
  ["clean", false],
  ["dirty", true],
]) {
  const parsed = await parseDocx(source);
  let pm = toProseDoc(parsed);
  if (dirty) {
    const para = pm.child(0);
    pm = pm.copy(
      pm.content.replaceChild(
        0,
        para.copy(
          para.content.addToEnd(pm.type.schema.text(" Unsaved amendment.")),
        ),
      ),
    );
  }
  const ydoc = prosemirrorToYDoc(pm, "prosemirror");
  writeYjsDocumentMetadata(ydoc, pm);
  const snapshot = encodeStateAsUpdate(ydoc);
  await Bun.write(name + ".yjs", snapshot);
  const materialized = await materializeYjsDocx({
    sourceDocx: source,
    yjsUpdate: snapshot,
  });
  console.log(
    name,
    ydoc.getMap("folio:document-metadata").toJSON(),
    await extractDocxText(materialized),
  );
  ydoc.destroy();
}
```
