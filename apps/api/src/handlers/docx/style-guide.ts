/**
 * Generates a prompt-friendly description of available DOCX styles
 * so the AI can dynamically choose which styles map to which
 * Markdown elements.
 *
 * The AI receives this guide, then returns:
 * 1. A style mapping (which style ID for each Markdown element)
 * 2. The Markdown content
 *
 * The converter uses the mapping to build the document.
 */

/**
 * Describes a single available style for the AI prompt.
 * In the future, TemplateAnalyzer will produce these from the
 * template's styles.xml. For now, hardcoded from our stock
 * template.
 */
export type StyleDescription = {
  id: string;
  name: string;
  description: string;
};

/** The AI's chosen mapping from Markdown elements to style IDs. */
export type StyleMapping = {
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  h5: string;
  h6: string;
  paragraph: string;
  blockquote: string;
};

/** Default mapping matching the stock Series A cascade. */
export const DEFAULT_STYLE_MAPPING: StyleMapping = {
  h1: "TitleNoSubheading",
  h2: "A1stLevelNumbering",
  h3: "A2ndLevelNumbering",
  h4: "A3rdLevelNumbering",
  h5: "A4thLevelNumbering",
  h6: "A5thLevelNumbering",
  paragraph: "A1",
  blockquote: "StockQuote",
};

/** Stock styles available in the template. */
const STOCK_STYLES: StyleDescription[] = [
  {
    id: "TitleNoSubheading",
    name: "Title (No Subheading)",
    description:
      "Document title. Centered, bold, large font. " +
      "No numbering. Use for the document name.",
  },
  {
    id: "TitleWithSubheading",
    name: "Title (With Subheading)",
    description:
      "Document title when followed by a subtitle. " +
      "Centered, bold. Next paragraph becomes Subheading.",
  },
  {
    id: "A1stLevelNumbering",
    name: "A_1st Level Numbering",
    description:
      "Top-level clause heading. Bold. Auto-numbered: " +
      "1, 2, 3... Use for major sections.",
  },
  {
    id: "A2ndLevelNumbering",
    name: "A_2nd Level Numbering",
    description:
      "Sub-clause. Bold. Auto-numbered: 1.1, 1.2, 1.3... " +
      "Use for paragraphs within a clause.",
  },
  {
    id: "A3rdLevelNumbering",
    name: "A_3rd Level Numbering",
    description:
      "Sub-sub-clause. Regular weight. Auto-numbered: " +
      "(a), (b), (c)... Use for enumerated points.",
  },
  {
    id: "A4thLevelNumbering",
    name: "A_4th Level Numbering",
    description:
      "Deep sub-clause. Regular weight. Auto-numbered: " +
      "(i), (ii), (iii)... Use for detailed sub-points.",
  },
  {
    id: "A5thLevelNumbering",
    name: "A_5th Level Numbering",
    description:
      "Deepest sub-clause. Regular weight. Auto-numbered: " +
      "(1), (2), (3)... Rarely used.",
  },
  {
    id: "A0",
    name: "A0",
    description:
      "Base body text. Arial 10pt, justified, no indent. " +
      "Use for preambles or text before numbered content.",
  },
  {
    id: "A1",
    name: "A1",
    description:
      "Indented body text. Same as A0 but with left indent. " +
      "Use for un-numbered paragraphs within clauses.",
  },
  {
    id: "Recitals",
    name: "Recitals",
    description:
      "Recital paragraph (WHEREAS clauses). " +
      "Un-numbered, used before the operative part.",
  },
  {
    id: "AgreedTerms",
    name: "Agreed Terms",
    description:
      "Section header for the operative part (e.g., " +
      '"IT IS AGREED"). Bold, un-numbered.',
  },
  {
    id: "StockQuote",
    name: "Stock Quote",
    description:
      "Indented italic block. Use for caveats, notes, " +
      'or "for the avoidance of doubt" clauses.',
  },
];

/**
 * Generate a prompt fragment describing the available styles.
 * Include this in the AI's system prompt so it can choose the
 * right mapping.
 *
 * @param styles - Style descriptions. Defaults to stock styles.
 */
export const generateStyleGuide = (
  styles: StyleDescription[] = STOCK_STYLES,
): string => {
  const lines = styles.map(
    (s) => `- **${s.name}** (\`${s.id}\`): ${s.description}`,
  );

  return [
    "## Available Document Styles",
    "",
    "The following styles are available in the output document.",
    "Choose which style maps to each Markdown element based on",
    "the document type you are generating.",
    "",
    ...lines,
    "",
    "### How to specify your mapping",
    "",
    "Before the Markdown content, output a JSON code block with",
    "your chosen mapping from Markdown elements to style IDs:",
    "",
    "```json",
    JSON.stringify(DEFAULT_STYLE_MAPPING, null, 2),
    "```",
    "",
    "Then output the Markdown content. Every heading level,",
    "paragraph, and blockquote will be rendered using the style",
    "you assigned to that element.",
  ].join("\n");
};
