import type { DecisionSection } from "@/api/handlers/case-law/types";

/**
 * Patterns for detecting structural section boundaries in
 * Czech and Slovak court decisions. Based on the CzCDC corpus
 * segmentation model (Harasta, Masaryk University).
 *
 * Each pattern maps to a section type with the regex matching
 * the section heading. Order matters: first match wins.
 */
const SECTION_PATTERNS: Array<{
  type: DecisionSection["type"];
  pattern: RegExp;
}> = [
  // Czech patterns
  {
    type: "ruling",
    pattern: /^V\s*[ýy]\s*r\s*o\s*k\s*[:.]?\s*$/im,
  },
  {
    type: "argumentation",
    pattern: /^Od[uů]vodn[eě]n[ií]\s*[:.]?\s*$/im,
  },
  {
    type: "dissent",
    pattern:
      /^(Odli[šs]n[ée]\s+stanovisko|Stanovisko\s+men[šs]iny)\s*[:.]?\s*$/im,
  },
  {
    type: "footer",
    pattern: /^Pou[čc]en[ií]\s*[:.]?\s*$/im,
  },
  // Slovak patterns
  {
    type: "ruling",
    pattern: /^(V[ýy]rok|Rozhodnutie)\s*[:.]?\s*$/im,
  },
  {
    type: "argumentation",
    pattern: /^Od[ôo]vodnenie\s*[:.]?\s*$/im,
  },
  {
    type: "footer",
    pattern: /^Pou[čc]enie\s*[:.]?\s*$/im,
  },
  // Procedural history
  {
    type: "history",
    pattern:
      /^(Pr[uů]b[eě]h\s+[řr][ií]zen[ií]|Procesn[ií]\s+historie)\s*[:.]?\s*$/im,
  },
  // Polish patterns
  {
    type: "ruling",
    pattern: /^(Sentencja|Tenor)\s*[:.]?\s*$/im,
  },
  {
    type: "argumentation",
    pattern: /^Uzasadnienie\s*[:.]?\s*$/im,
  },
  {
    type: "dissent",
    pattern: /^Zdanie\s+odr[eę]bne\s*[:.]?\s*$/im,
  },
  {
    type: "footer",
    pattern: /^Pouczenie\s*[:.]?\s*$/im,
  },
];

/**
 * Segment a court decision fulltext into structural sections.
 *
 * Uses regex-based heading detection to split the text into
 * sections following the CzCDC model: header, history,
 * argumentation, ruling, dissent, footer.
 *
 * Text before the first recognized heading becomes the
 * "header" section.
 */
export const segmentDecision = (fulltext: string): DecisionSection[] => {
  if (!fulltext.trim()) {
    return [];
  }

  const lines = fulltext.split("\n");
  const boundaries: Array<{
    lineIndex: number;
    type: DecisionSection["type"];
    title: string;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    for (const { type, pattern } of SECTION_PATTERNS) {
      if (pattern.test(line)) {
        boundaries.push({ lineIndex: i, type, title: line });
        break;
      }
    }
  }

  // No recognized sections: return entire text as header
  if (boundaries.length === 0) {
    return [
      {
        index: 0,
        type: "header",
        title: null,
        text: fulltext.trim(),
      },
    ];
  }

  const sections: DecisionSection[] = [];
  let sectionIndex = 0;

  // Text before first boundary is the header
  if (boundaries[0].lineIndex > 0) {
    const headerText = lines
      .slice(0, boundaries[0].lineIndex)
      .join("\n")
      .trim();

    if (headerText) {
      sections.push({
        index: sectionIndex++,
        type: "header",
        title: null,
        text: headerText,
      });
    }
  }

  // Each boundary starts a section that runs until the next
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const nextLineIndex =
      i + 1 < boundaries.length ? boundaries[i + 1].lineIndex : lines.length;

    const sectionText = lines
      .slice(boundary.lineIndex + 1, nextLineIndex)
      .join("\n")
      .trim();

    sections.push({
      index: sectionIndex++,
      type: boundary.type,
      title: boundary.title,
      text: sectionText,
    });
  }

  return sections;
};
