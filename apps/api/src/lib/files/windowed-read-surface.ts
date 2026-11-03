/** Every document window declares its owner and executable budget guard. */
export const WINDOWED_READ_SURFACE = {
  "mcp-content": {
    source: "mcp/stella-tools.ts",
    guard: "mcp/tools.test.ts",
    test: "MCP DOCX continuation windows reuse converted text for 1x and 10x documents",
  },
  "mcp-extracted": {
    source: "mcp/stella-tools.ts",
    guard: "mcp/tools.test.ts",
    test: "MCP extracted continuation windows reuse decrypted text for 1x and 10x documents",
  },
  "mcp-anonymized": {
    source: "mcp/window-anonymization-cache.ts",
    guard: "mcp/egress.test.ts",
    test: "anonymized continuation windows reuse session fields across document scales",
  },
  "case-law-reader": {
    source: "handlers/case-law/decisions/reader.ts",
    guard: "lib/case-law/windowed-read.postgres.test.ts",
    test: "every case-law window measures its admitted production owner",
  },
  "citation-passages": {
    source: "handlers/case-law/decisions/citation-passages.ts",
    guard: "lib/case-law/windowed-read.postgres.test.ts",
    test: "every case-law window measures its admitted production owner",
  },
  "reader-answer": {
    source: "lib/case-law/reader-answer-corpus.ts",
    guard: "lib/case-law/windowed-read.postgres.test.ts",
    test: "every case-law window measures its admitted production owner",
  },
  "analysis-input": {
    source: "handlers/case-law/analysis/analysis-input.ts",
    guard: "lib/case-law/windowed-read.postgres.test.ts",
    test: "every case-law window measures its admitted production owner",
  },
} as const;

export type WindowedReadSurface = keyof typeof WINDOWED_READ_SURFACE;

/** Transport and full-reader entry points that delegate their payload read. */
export const WINDOWED_READ_DELEGATES = {
  "mcp/decision-reader-tools.ts": "case-law-reader",
  "handlers/case-law/decisions/get.ts": "case-law-reader",
} as const satisfies Record<string, WindowedReadSurface>;
export type CaseLawWindowProfile = {
  [
    Key in WindowedReadSurface
  ]: (typeof WINDOWED_READ_SURFACE)[Key]["guard"] extends "lib/case-law/windowed-read.postgres.test.ts"
    ? Key
    : never;
}[WindowedReadSurface];

/** A new read cannot declare a surface without its budget guard in the registry. */
export const defineWindowedRead = <
  TFunction extends (...args: never[]) => unknown,
>(
  _surface: WindowedReadSurface,
  read: TFunction,
): TFunction => read;
