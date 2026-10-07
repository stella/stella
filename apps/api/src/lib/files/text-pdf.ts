/**
 * A minimal, readable text PDF built without a PDF library: one Helvetica
 * font, WinAnsi text, ~45 lines a page. For server-built sample documents
 * (development seeds and the restricted review organization), never for user
 * content.
 */

/**
 * Unicode → WinAnsiEncoding (CP1252) mapping for chars
 * outside ASCII. Helvetica supports these natively.
 *
 * Hex keys are the standard notation for Unicode code
 * points and CP1252 byte positions.
 */
const WIN_ANSI: Record<number, number> = {
  256: 0x00, // U+0100 fallback for unsupported chars
  // Latin Extended-A (Czech/Slovak/German)
  193: 0xc1, // Á
  225: 0xe1, // á
  196: 0xc4, // Ä
  228: 0xe4, // ä
  201: 0xc9, // É
  233: 0xe9, // é
  205: 0xcd, // Í
  237: 0xed, // í
  211: 0xd3, // Ó
  243: 0xf3, // ó
  212: 0xd4, // Ô
  244: 0xf4, // ô
  214: 0xd6, // Ö
  246: 0xf6, // ö
  218: 0xda, // Ú
  250: 0xfa, // ú
  220: 0xdc, // Ü
  252: 0xfc, // ü
  221: 0xdd, // Ý
  253: 0xfd, // ý
  223: 0xdf, // ß
  // Characters that need remapping to CP1252 positions
  268: 0x00, // Č → not in CP1252
  269: 0x00, // č
  270: 0x00, // Ď
  271: 0x00, // ď
  282: 0x00, // Ě
  283: 0x00, // ě
  313: 0x00, // Ĺ
  314: 0x00, // ĺ
  317: 0x00, // Ľ
  318: 0x00, // ľ
  327: 0x00, // Ň
  328: 0x00, // ň
  344: 0x00, // Ř
  345: 0x00, // ř
  352: 0x8a, // Š → CP1252 0x8A
  353: 0x9a, // š → CP1252 0x9A
  356: 0x00, // Ť
  357: 0x00, // ť
  366: 0x00, // Ů
  367: 0x00, // ů
  381: 0x8e, // Ž → CP1252 0x8E
  382: 0x9e, // ž → CP1252 0x9E
  340: 0x00, // Ŕ
  341: 0x00, // ŕ
};

// Fallback ASCII for chars not in WinAnsi
const FALLBACK: Record<string, string> = {
  Č: "C",
  č: "c",
  Ď: "D",
  ď: "d",
  Ě: "E",
  ě: "e",
  Ĺ: "L",
  ĺ: "l",
  Ľ: "L",
  ľ: "l",
  Ň: "N",
  ň: "n",
  Ř: "R",
  ř: "r",
  Ť: "T",
  ť: "t",
  Ů: "U",
  ů: "u",
  Ŕ: "R",
  ŕ: "r",
};

/** Encode a string for PDF text operators using
 *  WinAnsiEncoding. Non-encodable chars get an ASCII
 *  fallback. Returns an octal-escaped PDF string. */
const pdfEscape = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      // ASCII — escape PDF special chars
      if (ch === "\\") {
        out += "\\\\";
      } else if (ch === "(") {
        out += "\\(";
      } else if (ch === ")") {
        out += "\\)";
      } else {
        out += ch;
      }
    } else {
      const winAnsi = WIN_ANSI[cp];
      if (winAnsi !== undefined && winAnsi > 0) {
        // Encodable in WinAnsi — use octal escape
        out += `\\${winAnsi.toString(8).padStart(3, "0")}`;
      } else {
        // Not in WinAnsi — ASCII fallback
        out += FALLBACK[ch] ?? "?";
      }
    }
  }
  return out;
};

/**
 * Create a minimal but readable multi-page PDF.
 * Each page holds ~45 lines at 11pt with 14pt leading.
 */
export const createTextPdf = (title: string, bodyText?: string): Buffer => {
  const LINES_PER_PAGE = 45;
  const FONT_SIZE = 11;
  const LEADING = 14;
  const TITLE_SIZE = 16;
  const MARGIN_LEFT = 56;
  const TOP_Y = 740;

  // Split body text into lines, wrapping long lines at ~85 chars
  const rawLines = (bodyText ?? title).split("\n");
  const allLines: string[] = [];
  for (const raw of rawLines) {
    if (raw.length <= 85) {
      allLines.push(raw);
    } else {
      // Word-wrap
      const words = raw.split(" ");
      let line = "";
      for (const word of words) {
        if (line.length + word.length + 1 > 85) {
          allLines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) {
        allLines.push(line);
      }
    }
  }

  // Group into pages
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) {
    pages.push([title]);
  }

  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
  ];

  // Build content streams for each page
  const pageObjIds: number[] = [];
  const contentObjStart = 4; // objects 4, 5, 6, ... are content streams
  const pageObjStart = contentObjStart + pages.length;

  for (const [p, lines] of pages.entries()) {
    let stream = "";

    // Title on first page
    if (p === 0) {
      stream +=
        `BT /F1 ${TITLE_SIZE} Tf ` +
        `${MARGIN_LEFT} ${TOP_Y} Td ` +
        `(${pdfEscape(title)}) Tj ` +
        `0 -${LEADING * 2} Td ` +
        `/F1 ${FONT_SIZE} Tf `;
    } else {
      stream += `BT /F1 ${FONT_SIZE} Tf ${MARGIN_LEFT} ${TOP_Y} Td `;
    }

    for (const [i, line] of lines.entries()) {
      if (i > 0 || p > 0) {
        stream += `0 -${LEADING} Td `;
      }
      stream += `(${pdfEscape(line)}) Tj `;
    }
    stream += "ET";

    const contentId = contentObjStart + p;
    objects.push(
      `${contentId} 0 obj\n<< /Length ${stream.length} >>\n` +
        `stream\n${stream}\nendstream\nendobj`,
    );

    const pageId = pageObjStart + p;
    pageObjIds.push(pageId);
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj`,
    );
  }

  // Pages object (id 2)
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(" ");
  objects.splice(
    1,
    0,
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] ` +
      `/Count ${pages.length} >>\nendobj`,
  );

  // Font object (id 3)
  objects.splice(
    2,
    0,
    "3 0 obj\n<< /Type /Font /Subtype /Type1 " +
      "/BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj",
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj}\n`;
  }

  const xrefOffset = pdf.length;
  pdf += "xref\n";
  pdf += `0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += "trailer\n";
  pdf += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += "startxref\n";
  pdf += `${xrefOffset}\n`;
  pdf += "%%EOF\n";

  return Buffer.from(pdf);
};
