export type GlossaryEntry = {
  banned: RegExp;
  preferred: string;
  reason: string;
};

const sharedEntries = [
  {
    banned: /\bStella\b/u,
    preferred: "stella",
    reason: "The product wordmark is always lowercase.",
  },
] as const satisfies readonly GlossaryEntry[];

export const glossary = {
  ar: sharedEntries,
  cs: sharedEntries,
  de: sharedEntries,
  en: [
    ...sharedEntries,
    {
      banned: /\borganisation(?:s|'s)?\b/iu,
      preferred: "organization",
      reason: "English product copy uses US spelling.",
    },
  ],
  es: sharedEntries,
  et: sharedEntries,
  fr: sharedEntries,
  hu: sharedEntries,
  lt: sharedEntries,
  lv: sharedEntries,
  pl: sharedEntries,
  "pt-BR": sharedEntries,
  sk: sharedEntries,
} as const satisfies Record<string, readonly GlossaryEntry[]>;
