/**
 * One opinion a decision prints (the majority, a concurrence, a dissent) and
 * the AST blocks it consists of, footnotes included. A short-form citation
 * never reaches back across an opinion, so its boundaries are structure the
 * parser states, not wording the extractor guesses from.
 */
export type CitationOpinionScope = {
  opinionId: string;
  blockIds: readonly string[];
  boundaries: "proven" | "unproven";
};
