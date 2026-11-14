/**
 * What a document is to a list's facts: `document` when it records what
 * happened (a letter, minutes, a register), `testimony` when it is a
 * person's account of it (a witness statement, an interview note, a
 * transcript).
 */
export const LIST_SOURCE_KINDS = ["document", "testimony"] as const;
export type ListSourceKind = (typeof LIST_SOURCE_KINDS)[number];
