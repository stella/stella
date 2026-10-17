/** Synthetic publisher-shaped text; contains no copied authority content. */
export const SOFT_LAW_PDF_SHAPES = {
  "cz-uoou": [
    { text: "Metodika pro spravce", y: 720, size: 18 },
    { text: "1. Spravce popise ucel zpracovani.", y: 680, size: 12 },
    { text: "2. Informace musi byt dostupne.", y: 640, size: 12 },
  ],
  "eu-edpb": [
    { text: "Guidelines on transparent information", y: 720, size: 18 },
    {
      text: "1. Controllers explain their processing purposes.",
      y: 680,
      size: 12,
    },
    { text: "2. A notice describes the retention period.", y: 640, size: 12 },
    { text: "| Category | Retention |", y: 500, size: 12 },
    { text: "| Contact | One year |", y: 484, size: 12 },
    { text: "1 This synthetic note explains the notice.", y: 80, size: 8 },
    { text: "The explanation continues on a second line.", y: 68, size: 8 },
  ],
  "eu-wp29": [
    { text: "What information should a notice contain?", y: 720, size: 12 },
    {
      text: "A notice describes the purpose and retention period.",
      y: 680,
      size: 12,
    },
    { text: "How can a person request access?", y: 640, size: 12 },
    { text: "The notice provides a clear contact point.", y: 600, size: 12 },
  ],
} as const;
