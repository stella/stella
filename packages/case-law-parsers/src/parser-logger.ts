// parser-output-unchanged: structured parser logging sink is an output-independent side effect.
/**
 * Structured logging sink for case-law parser diagnostics.
 *
 * Parsers default to no-op logging so `@stll/case-law-parsers` stays decoupled
 * from host observability. `apps/api` registers its structured logger once on
 * startup via `setParserLogger`.
 */
export type ParserLogger = {
  warn: (message: string, attributes?: Record<string, unknown>) => void;
  error: (message: string, attributes?: Record<string, unknown>) => void;
};

let activeLogger: ParserLogger | undefined;

export const setParserLogger = (logger: ParserLogger): void => {
  activeLogger = logger;
};

export const getParserLogger = (): ParserLogger | undefined => activeLogger;
