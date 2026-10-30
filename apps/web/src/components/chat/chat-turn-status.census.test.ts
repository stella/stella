import { expect, test } from "bun:test";
import ts from "typescript6";

const OWNER = "src/components/chat/chat-turn-status.tsx";
const ALLOWED_NON_TURN_LOADERS = {
  "src/components/chat/ask-user-card.tsx": "submitting a user answer",
  "src/components/chat/chat-message-actions-menu.tsx": "export action",
  "src/components/chat/chat-prompt-improve-button.tsx": "prompt rewrite action",
  "src/components/chat/connect-connector-card.tsx": "connector authorization",
  "src/components/chat/message-export-menu.tsx": "message export action",
  "src/components/chat/needs-matter-card.tsx": "matter creation action",
  "src/components/chat/request-secret-card.tsx": "secret submission action",
  "src/components/chat/side-panel-chat-status.tsx":
    "side-panel connection status",
  "src/components/chat/spawn-subagents-card.tsx": "subagent action",
  "src/components/chat/tool-approval-card.tsx": "approval submission action",
  "src/features/chat/components/chat-title-rename.tsx": "title rename action",
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

test("the turn status owner is the only turn loader or elapsed ticker", async () => {
  const files = [
    ...new Bun.Glob("src/components/chat/**/*.{ts,tsx}").scanSync("."),
    ...new Bun.Glob("src/features/chat/**/*.{ts,tsx}").scanSync("."),
  ];
  expect(files).toContain(OWNER);
  const violations: string[] = [];
  for (const file of files) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
      continue;
    }
    const source = await Bun.file(file).text();
    const ownsLiveIndicator =
      source.includes("@stll/ui/loader") ||
      source.includes("use-live-elapsed") ||
      hasPotentialRunningMark(source) ||
      source.includes("animate-spin");
    if (
      ownsLiveIndicator &&
      file !== OWNER &&
      !(file in ALLOWED_NON_TURN_LOADERS)
    ) {
      violations.push(file);
    }
  }
  expect(violations).toEqual([]);
  expect(await Bun.file(OWNER).text()).toContain("data-turn-live-status");
});
