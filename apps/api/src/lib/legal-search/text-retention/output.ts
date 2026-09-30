import { panic, Result } from "better-result";

import type { DocumentAst, Inline } from "@stll/legal-ast/document-ast";

import { TEXT_ORACLE_LIMITS, TextOracleError } from "./types";

type OutputTextInput =
  | { type: "ast"; documentAst: DocumentAst }
  | { type: "fulltext"; fulltext: string };

/** Read rendered content independently of cached search plainText and metadata. */
export const readOutputText = (input: OutputTextInput) => {
  switch (input.type) {
    case "fulltext":
      return input.fulltext.length > TEXT_ORACLE_LIMITS.textCharacters
        ? Result.err(
            new TextOracleError({
              reason: "resource_limit",
              message: "Output text exceeds the character limit",
            }),
          )
        : Result.ok({ text: input.fulltext });
    case "ast":
      break;
    default:
      input satisfies never;
      return panic("Unhandled output text representation");
  }
  const parts: string[] = [];
  let characters = 0;
  let nodes = 0;
  const append = (text: string) => {
    characters += text.length;
    parts.push(text);
  };
  const inlineText = (inlines: readonly Inline[]) => {
    const stack = inlines.toReversed().map((inline) => ({ inline, depth: 0 }));
    while (stack.length > 0) {
      const item = stack.pop();
      if (item === undefined) {
        panic("Output traversal stack is unexpectedly empty");
      }
      const { inline, depth } = item;
      nodes += 1;
      if (
        nodes > TEXT_ORACLE_LIMITS.nodes ||
        depth > TEXT_ORACLE_LIMITS.depth ||
        characters > TEXT_ORACLE_LIMITS.textCharacters
      ) {
        return false;
      }
      switch (inline.type) {
        case "text":
          append(inline.text);
          break;
        case "line-break":
          append("\n");
          break;
        case "page-anchor":
          break;
        case "bold":
        case "italic":
        case "underline":
        case "superscript":
        case "subscript":
        case "link":
        case "citation":
          for (const child of inline.children.toReversed()) {
            stack.push({ inline: child, depth: depth + 1 });
          }
          break;
        default:
          inline satisfies never;
          panic("Unhandled output inline");
      }
    }
    return true;
  };
  let previousNoteId: string | undefined;
  for (const block of input.documentAst.blocks) {
    nodes += 1;
    if (nodes > TEXT_ORACLE_LIMITS.nodes) {
      return Result.err(
        new TextOracleError({
          reason: "resource_limit",
          message: "Output AST exceeds the node limit",
        }),
      );
    }
    append("\n");
    switch (block.type) {
      case "paragraph":
      case "table":
        if (
          block.note !== undefined &&
          (block.note.noteId === undefined ||
            block.note.noteId !== previousNoteId)
        ) {
          append(`${block.note.label} `);
        }
        previousNoteId = block.note?.noteId;
        break;
      case "heading":
      case "image":
        previousNoteId = undefined;
        break;
      default:
        block satisfies never;
        panic("Unhandled output block note");
    }
    let complete = true;
    switch (block.type) {
      case "paragraph":
      case "heading":
        complete = inlineText(block.inlines);
        break;
      case "table":
        for (const row of block.rows) {
          for (const cell of row) {
            nodes += 1;
            if (nodes > TEXT_ORACLE_LIMITS.nodes) {
              return Result.err(
                new TextOracleError({
                  reason: "resource_limit",
                  message: "Output AST exceeds the cell limit",
                }),
              );
            }
            if (!inlineText(cell.inlines)) {
              complete = false;
            }
            append("\t");
          }
          append("\n");
        }
        break;
      case "image":
        append(block.alt ?? "");
        break;
      default:
        block satisfies never;
        panic("Unhandled output block");
    }
    if (!complete || characters > TEXT_ORACLE_LIMITS.textCharacters) {
      return Result.err(
        new TextOracleError({
          reason: "resource_limit",
          message: "Output AST exceeds the traversal limit",
        }),
      );
    }
  }
  return Result.ok({ text: parts.join("") });
};
