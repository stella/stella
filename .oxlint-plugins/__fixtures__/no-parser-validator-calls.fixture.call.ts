declare const validateAndLog: (source: string, blocks: unknown[]) => void;
declare const validateAst: (source: string, blocks: unknown[]) => void;
declare const oracle: { validateAst: typeof validateAst };

// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: a validator call without a local import is still forbidden
validateAndLog("<p>source</p>", []);
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: direct oracle invocation cannot be parser-owned
validateAst("<p>source</p>", []);
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls -- fixture: namespace validator invocation is still direct oracle access
oracle.validateAst("<p>source</p>", []);
// oxlint-disable-next-line no-parser-validator-calls/no-parser-validator-calls, typescript/dot-notation -- fixture: computed static member invocation must exercise bracket access
oracle["validateAst"]("<p>source</p>", []);

// expect-clean: no-parser-validator-calls/no-parser-validator-calls
export const renderText = (source: string) => source;
