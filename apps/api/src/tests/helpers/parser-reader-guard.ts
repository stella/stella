import { panic, type Result } from "better-result";
import * as v from "valibot";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { persistedCorpusAstSchema } from "@/api/lib/legal-search/corpus-ast";
import { isRecord } from "@/api/lib/type-guards";

/** The persisted schema is also the reader's admission contract. */
export const assertReaderAcceptsAst = (ast: unknown): void => {
  v.parse(persistedCorpusAstSchema, ast);
};

const assertParserOutput = (output: unknown): void => {
  if (!isRecord(output)) {
    if (output === null) {
      return;
    }
    panic("Fixture parser returned an unsupported result");
  }
  if ("version" in output && "blocks" in output) {
    assertReaderAcceptsAst(output);
    return;
  }
  if (output["type"] === "unkeyable") {
    return;
  }
  if ("documentAst" in output) {
    assertReaderAcceptsAst(output["documentAst"]);
    return;
  }
  if ("supplement" in output && isRecord(output["supplement"])) {
    assertParserOutput(output["supplement"]["document"]);
    return;
  }
  if ("decision" in output) {
    assertParserOutput(output["decision"]);
    return;
  }
  // Result-returning parsers expose the successful parse through `value`.
  if ("value" in output) {
    assertParserOutput(output["value"]);
    return;
  }
  if ("error" in output) {
    return;
  }
  panic("Fixture parser returned no document AST or typed error");
};

function checkedOutput<T>(output: Promise<T>): Promise<T>;
function checkedOutput<T>(output: T): T;
function checkedOutput<T>(output: T | Promise<T>): T | Promise<T> {
  if (output instanceof Promise) {
    return output.then((value) => checkedOutput(value));
  }
  assertParserOutput(output);
  return output;
}

/** Preserve each parser's inferred API while checking every successful fixture parse. */
type ParsedDocument = { documentAst: unknown };
type ParserOutput =
  | { type: "supplement"; supplement: { document: ParsedDocument } }
  | DocumentAst
  | { type: "unkeyable" }
  | ParsedDocument
  | { decision: ParsedDocument }
  | Result<ParsedDocument, unknown>
  | null;

export const guardParser =
  <Args extends unknown[], Output extends ParserOutput | Promise<ParserOutput>>(
    parse: (...args: Args) => Output,
  ) =>
  (...args: Args) =>
    checkedOutput(parse(...args));
