import type { DecisionSection } from "@/api/handlers/case-law/types";

/**
 * Patterns for detecting structural section boundaries in
 * Czech and Slovak court decisions. Based on the CzCDC corpus
 * segmentation model (Harasta, Masaryk University).
 *
 * Each pattern maps to a section type with the regex matching
 * the section heading. Order matters: first match wins.
 */
const SECTION_PATTERNS: {
  type: DecisionSection["type"];
  pattern: RegExp;
}[] = [
  // Czech patterns (compact headings)
  {
    type: "ruling",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^V\s*[ýy]\s*r\s*o\s*k\s*[:.]?\s*$/imu,
  },
  {
    type: "argumentation",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^Od[uů]vodn[eě]n[ií]\s*[:.]?\s*$/imu,
  },
  {
    type: "dissent",
    pattern:
      // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
      /^(Odli[šs]n[ée]\s+stanovisko|Stanovisko\s+men[šs]iny)\s*[:.]?\s*$/imu,
  },
  {
    type: "footer",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^Pou[čc]en[ií]\s*[:.]?\s*$/imu,
  },

  // Czech spaced headings (NSS style: "O d ů v o d n ě n í :")
  // Verified: zero false positives across 60k decisions.
  {
    type: "ruling",
    pattern: /^t\s+a\s+k\s+t\s+o\s*:\s*$/imu,
  },
  {
    type: "argumentation",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^O\s+d\s+[ůu]\s+v\s+o\s+d\s+n\s+[ěe]\s+n\s+[ií]\s*[:.]?\s*$/imu,
  },
  {
    type: "footer",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^P\s+o\s+u\s+[čc]\s+e\s+n\s+[ií]\s*[:.]?\s*$/imu,
  },

  // Czech non-spaced "takto:" on its own line (NSS/NS)
  {
    type: "ruling",
    pattern: /^takto\s*:\s*$/imu,
  },

  // ÚS (Constitutional Court) section headings
  {
    type: "history",
    pattern: /^Skutkov[ée]\s+okolnosti\s+p[řr][ií]padu/imu,
  },

  // Slovak patterns
  {
    type: "ruling",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^(V[ýy]rok|Rozhodnutie)\s*[:.]?\s*$/imu,
  },
  {
    type: "argumentation",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^Od[ôo]vodnenie\s*[:.]?\s*$/imu,
  },
  {
    type: "footer",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^Pou[čc]enie\s*[:.]?\s*$/imu,
  },

  // Procedural history
  {
    type: "history",
    pattern:
      // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
      /^(Pr[uů]b[eě]h\s+[řr][ií]zen[ií]|Procesn[ií]\s+historie)\s*[:.]?\s*$/imu,
  },

  // Polish patterns
  {
    type: "ruling",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^(Sentencja|Tenor)\s*[:.]?\s*$/imu,
  },
  {
    type: "argumentation",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^Uzasadnienie\s*[:.]?\s*$/imu,
  },
  {
    type: "dissent",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^Zdanie\s+odr[eę]bne\s*[:.]?\s*$/imu,
  },
  {
    type: "footer",
    // oxlint-disable-next-line sonarjs/slow-regex -- section patterns are matched against a single trimmed line
    pattern: /^Pouczenie\s*[:.]?\s*$/imu,
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
  const boundaries: {
    lineIndex: number;
    type: DecisionSection["type"];
    title: string;
  }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) {
      continue;
    }
    const line = rawLine.trim();
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
  const firstBoundary = boundaries[0];
  if (firstBoundary && firstBoundary.lineIndex > 0) {
    const headerText = lines
      .slice(0, firstBoundary.lineIndex)
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
    if (!boundary) {
      continue;
    }
    const nextBoundary = boundaries[i + 1];
    const nextLineIndex = nextBoundary ? nextBoundary.lineIndex : lines.length;

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
