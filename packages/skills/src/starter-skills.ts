/**
 * The slash-command skills every member starts with, seeded as private rows of
 * their own when they join an organization.
 *
 * This English text is what gets stored, and also how the web app recognises a
 * value nobody has edited: a stored name, description or body that still equals
 * it is shown in the reader's language instead. Rewording an entry here leaves
 * the rows already seeded with the old text, and those stop being translated.
 */
export const STARTER_SKILLS = [
  {
    slug: "summarize-default",
    command: "summarize",
    name: "Summarise a document",
    description: "Get a structured summary of the key terms",
    body: "Summarise this document. Cover parties, key obligations, dates, financial terms, and any termination or liability provisions.",
  },
  {
    slug: "risks-default",
    command: "risks",
    name: "Find risks",
    description: "Spot legal risks and ambiguous clauses",
    body: "Review this document for legal risks, missing protections, and ambiguous clauses. Cite the specific clause for each finding.",
  },
  {
    slug: "compare-default",
    command: "compare",
    name: "Compare versions",
    description: "List every material change between two versions",
    body: "Compare two versions of this document and list every material change with its location.",
  },
  {
    slug: "draft-default",
    command: "draft",
    name: "Draft a response",
    description: "Draft a professional reply to a letter",
    body: "Draft a measured response to this letter. Keep the tone professional, address each point raised, and flag any open questions for me to confirm.",
  },
] as const;

export type StarterSkillSlug = (typeof STARTER_SKILLS)[number]["slug"];
