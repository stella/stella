import { panic } from "better-result";
import JSZip from "jszip";
import { readdir } from "node:fs/promises";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { discoverTemplate } from "@/api/lib/docx/discover-template";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { testDocxFile } from "@/api/tests/helpers/scanned-file";

const engineParityFixtureDirectory = new URL(
  "../../lib/docx/fixtures/",
  import.meta.url,
);
export const engineParityOutputDirectory = new URL(
  "../../lib/docx/fixtures/main-engine-xml/",
  import.meta.url,
);

export const engineParityCases = async () => {
  const names = (await readdir(engineParityFixtureDirectory))
    .filter((name) => name.endsWith(".docx"))
    .toSorted();
  const cases = [];
  for (const name of names) {
    const file = testDocxFile(
      await Bun.file(new URL(name, engineParityFixtureDirectory)).arrayBuffer(),
    );
    const { placeholders } = await discoverTemplate(file);
    const values = Object.fromEntries(
      placeholders.map(({ name: path }) => [path, `Filled ${path}`]),
    );
    cases.push({ name, file, values });
  }
  const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const body = [
    p("{% for group in groups %}"),
    p("{{ group.name }}"),
    p("{% for child in group.children %}"),
    p("{{ child.name }}"),
    p("{% endfor %}"),
    p(
      "Inline: {% for child in group.children %}{{ child.name }}, {% endfor %}",
    ),
    p("{% endfor %}"),
    `<w:tbl><w:tr><w:tc>${p("{% for row in rows %}") + p("{{ row.name }}") + p("{% endfor %}")}</w:tc></w:tr></w:tbl>`,
  ].join("");
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  cases.push({
    name: "directive-loops.docx",
    file: testDocxFile(await zip.generateAsync({ type: "uint8array" })),
    values: {
      groups: [
        {
          name: "Outer A",
          children: [{ name: "Inner A1" }, { name: "Inner A2" }],
        },
        { name: "Outer B", children: [{ name: "Inner B1" }] },
      ],
      rows: [{ name: "Row A" }, { name: "Row B" }],
    },
  });
  return cases;
};

// Retain exact XML equality evidence without copying fixture content.
export const engineParityXmlDigests = async (file: ScannedFile) => {
  const zip = await JSZip.loadAsync(file.bytes);
  const parts: Record<string, string> = {};
  for (const path of Object.keys(zip.files)
    .filter((partName) => partName.endsWith(".xml"))
    .toSorted()) {
    const entry = zip.file(path);
    if (!entry) {
      panic(`Missing XML part ${path}`);
    }
    parts[path] = hashSha256Hex(await entry.async("string"));
  }
  return `${JSON.stringify(parts, null, 2)}\n`;
};
