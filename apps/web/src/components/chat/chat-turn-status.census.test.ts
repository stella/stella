import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import ts from "typescript6";

import { sourceFileIndex } from "@stll/scripts/src/source-file-index";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OWNER = "components/chat/chat-turn-status.tsx";
const CHAT_SOURCE_PATH = /^(?:components|features)\/chat\//u;
const ALLOWED_NON_TURN_LOADERS = {
  "components/chat/ask-user-card.tsx": "submitting a user answer",
  "components/chat/chat-message-actions-menu.tsx": "export action",
  "components/chat/chat-prompt-improve-button.tsx": "prompt rewrite action",
  "components/chat/connect-connector-card.tsx": "connector authorization",
  "components/chat/message-export-menu.tsx": "message export action",
  "components/chat/needs-matter-card.tsx": "matter creation action",
  "components/chat/request-secret-card.tsx": "secret submission action",
  "components/chat/side-panel-chat-status.tsx": "side-panel connection status",
  "components/chat/spawn-subagents-card.tsx": "subagent action",
  "components/chat/tool-approval-card.tsx": "approval submission action",
  "features/chat/components/chat-title-rename.tsx": "title rename action",
} as const;

// Computed props cannot prove the absence of a running mark. Require explicit
// settled literals outside the live owner and independently scoped actions.
const hasPotentialRunningMark = (source: string) => {
  const ast = ts.createSourceFile(
    "status.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = new Set(["StatusMark"]);
  const collect = (node: ts.Node) => {
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName ?? node.name).text === "StatusMark"
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(ast);
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      names.has(node.tagName.getText(ast))
    ) {
      const status = node.attributes.properties.find(
        (prop) =>
          ts.isJsxAttribute(prop) && prop.name.getText(ast) === "status",
      );
      if (
        status === undefined ||
        !ts.isJsxAttribute(status) ||
        status.initializer === undefined ||
        !ts.isStringLiteral(status.initializer) ||
        !["done", "failed", "pending"].includes(status.initializer.text) ||
        node.attributes.properties.some(ts.isJsxSpreadAttribute)
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
};

test("detects literal, computed, aliased, and spread running marks", () => {
  for (const source of [
    '<StatusMark status="running" />',
    "<StatusMark status={status} />",
    '<StatusMark status={active ? "running" : "done"} />',
    "<StatusMark {...props} />",
    'import { StatusMark as Mark } from "@stll/ui/status-mark"; const row = <Mark status={status} />;',
  ]) {
    expect(hasPotentialRunningMark(source)).toBe(true);
  }
  for (const status of ["done", "failed", "pending"]) {
    expect(hasPotentialRunningMark(`<StatusMark status="${status}" />`)).toBe(
      false,
    );
  }
});

test("the turn status owner is the only turn loader or elapsed ticker", () => {
  const files = sourceFileIndex(SOURCE_ROOT).filter(({ relativePath }) =>
    CHAT_SOURCE_PATH.test(relativePath),
  );
  const owner = files.find(({ relativePath }) => relativePath === OWNER);
  expect(owner).toBeDefined();
  const violations: string[] = [];
  for (const { relativePath, sourceText } of files) {
    if (/\.test\.tsx?$/u.test(relativePath)) {
      continue;
    }
    const ownsLiveIndicator =
      sourceText.includes("@stll/ui/loader") ||
      sourceText.includes("use-live-elapsed") ||
      hasPotentialRunningMark(sourceText) ||
      sourceText.includes("animate-spin");
    if (
      ownsLiveIndicator &&
      relativePath !== OWNER &&
      !(relativePath in ALLOWED_NON_TURN_LOADERS)
    ) {
      violations.push(relativePath);
    }
  }
  expect(violations).toEqual([]);
  expect(owner?.sourceText).toContain("data-turn-live-status");
});
