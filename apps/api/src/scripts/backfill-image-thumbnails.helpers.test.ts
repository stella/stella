import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

describe("chat thumbnail backfill query", () => {
  test("always joins the chat thread for organization ownership", () => {
    const helperPath = path.resolve(
      import.meta.dir,
      "../../scripts/backfill-image-thumbnails.helpers.ts",
    );
    const { program } = parseSource(
      helperPath,
      fs.readFileSync(helperPath, "utf-8"),
    );
    const declaration = program.body
      .map((statement) =>
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement,
      )
      .find(
        (statement) =>
          statement?.type === "VariableDeclaration" &&
          statement.declarations.some(
            (item) =>
              item.id.type === "Identifier" &&
              item.id.name === "buildChatThumbnailQuery",
          ),
      );
    const initializer =
      declaration?.type === "VariableDeclaration"
        ? declaration.declarations.at(0)?.init
        : undefined;
    expect(initializer?.type).toBe("ArrowFunctionExpression");
    const callsInnerJoin = (node: Node) => {
      let found = false;
      walk(node, (child) => {
        if (
          child.type === "CallExpression" &&
          child.callee.type === "MemberExpression" &&
          child.callee.property.type === "Identifier" &&
          !child.callee.computed &&
          child.callee.property.name === "innerJoin"
        ) {
          found = true;
        }
      });
      return found;
    };
    expect(initializer && callsInnerJoin(initializer)).toBe(true);
    expect(fs.readFileSync(helperPath, "utf-8")).toContain(
      "organizationId: chatThreads.organizationId",
    );
  });
});
