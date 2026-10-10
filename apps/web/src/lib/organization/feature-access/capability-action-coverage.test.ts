import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const SOURCE_INVENTORY_TIMEOUT_MS = 30_000;

// Event handlers are inspected as syntax nodes: labels and imports cannot satisfy admission.
const dependentFlow =
  /onTranslate|openTranslation|setTranslation|handleRunOcr|run-ocr|queueOcr|onSign\b|pdfSignFlow\.start|onOpenInDesktop|onChatAbout|insertIntoChat|askInChat|onAskAI|sendToChat|runPropertyRows|runSelectedAIColumns|verifyList|openNewChat|askAboutPassage|askInNewChat|quoteInReply|insertChatMention|onNewThread|handleCreateAvt|askAboutThis|onOpenChat/iu;
const actionElement =
  /^(MenuItem|ContextMenuItem|DropdownMenuItem|Button|IconButton|CommandItem|ResponsiveActionButton|ToolbarIconAction|BuiltInTemplateRow)$/u;
const protectedFixture = (child: string) =>
  `<CapabilityAction action={{ capability: "ai" }}>{(capabilityProps) => (${child.replace(">Action", " {...capabilityProps}>Action")})}</CapabilityAction>`;
const inspect = (source: string, fileName: string) => {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const missing: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(file) === "CapabilityAction"
    ) {
      const expression = node.children.find(
        (child) => ts.isJsxExpression(child) && child.expression !== undefined,
      );
      let forwardsLast = false;
      if (
        expression !== undefined &&
        ts.isJsxExpression(expression) &&
        expression.expression !== undefined &&
        ts.isArrowFunction(expression.expression)
      ) {
        const callback = expression.expression;
        const parameter = callback.parameters.at(0);
        let body = callback.body;
        while (ts.isParenthesizedExpression(body)) {
          body = body.expression;
        }
        const opening = (() => {
          if (ts.isJsxElement(body)) {
            return body.openingElement;
          }
          if (ts.isJsxSelfClosingElement(body)) {
            return body;
          }
          return undefined;
        })();
        const last = opening?.attributes.properties.at(-1);
        forwardsLast =
          parameter !== undefined &&
          ts.isIdentifier(parameter.name) &&
          last !== undefined &&
          ts.isJsxSpreadAttribute(last) &&
          ts.isIdentifier(last.expression) &&
          last.expression.text === parameter.name.text;
      }
      if (!forwardsLast) {
        missing.push(
          `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`,
        );
      }
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      actionElement.test(node.tagName.getText(file))
    ) {
      const handlers = node.attributes.properties.filter(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          /^(onClick|onSelect|onUse)$/u.test(attribute.name.getText(file)),
      );
      if (
        handlers.some((handler) => {
          const text = handler.getText(file);
          if (dependentFlow.test(text)) {
            return true;
          }
          if (
            fileName.endsWith("desktop-open-button.tsx") &&
            /gate\.run/u.test(text)
          ) {
            return true;
          }
          if (
            fileName.endsWith("provision-ask-actions.tsx") &&
            /\b(summarize|ask)\b/u.test(text)
          ) {
            return true;
          }
          if (
            fileName.endsWith("ai-column-run-controls.tsx") &&
            /\bonRun\b/u.test(text)
          ) {
            return true;
          }
          if (
            fileName.endsWith("search-dialog-results.tsx") &&
            /\bonClick\b/u.test(text)
          ) {
            let owner: ts.Node = node;
            while (!ts.isSourceFile(owner)) {
              if (
                ts.isVariableDeclaration(owner) &&
                owner.name.getText(file) === "SearchSummaryItem"
              ) {
                return true;
              }
              owner = owner.parent;
            }
          }
          return false;
        })
      ) {
        let parent = node.parent;
        let declared =
          node.tagName.getText(file) === "BuiltInTemplateRow" &&
          node.attributes.properties.some(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(file) === "capability" &&
              attribute.initializer !== undefined,
          );
        while (!ts.isSourceFile(parent) && !declared) {
          if (
            ts.isJsxElement(parent) &&
            parent.openingElement.tagName.getText(file) === "CapabilityAction"
          ) {
            declared = parent.openingElement.attributes.properties.some(
              (attribute) => {
                if (
                  !ts.isJsxAttribute(attribute) ||
                  attribute.name.getText(file) !== "action" ||
                  attribute.initializer === undefined
                ) {
                  return false;
                }
                if (
                  !ts.isJsxExpression(attribute.initializer) ||
                  attribute.initializer.expression === undefined
                ) {
                  return false;
                }
                const expression = attribute.initializer.expression;
                if (!ts.isObjectLiteralExpression(expression)) {
                  return true;
                }
                return expression.properties.some(
                  (property) =>
                    ts.isPropertyAssignment(property) &&
                    property.name.getText(file) === "capability" &&
                    property.initializer.kind !== ts.SyntaxKind.NullKeyword,
                );
              },
            );
            break;
          }
          parent = parent.parent;
        }
        if (!declared) {
          missing.push(
            `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`,
          );
        }
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const callbacks = node.properties.filter(
        (property) =>
          ts.isPropertyAssignment(property) &&
          /^(run|onClick|onSelect)$/u.test(property.name.getText(file)),
      );
      const actionShape = node.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          /^(label|titleKey)$/u.test(property.name.getText(file)),
      );
      if (
        actionShape &&
        callbacks.some((callback) => dependentFlow.test(callback.getText(file)))
      ) {
        const declared = node.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(file) === "capability" &&
            property.initializer.kind !== ts.SyntaxKind.NullKeyword,
        );
        if (!declared) {
          missing.push(
            `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(missing)];
};
describe("capability flow action declarations", () => {
  test("production-shaped callback references and inline handlers fail without a declaration", () => {
    for (const handler of [
      "onTranslate",
      "() => detached(queueOcr(), 'ocr')",
      "onOpenInDesktop",
      "onChatAbout",
      "onSign",
      "askAboutPassage",
      "askInNewChat",
      "quoteInReply",
      "() => insertChatMention(editor, mention)",
      "onNewThread",
      "handleCreateAvt",
      "askAboutThis",
    ]) {
      const bad = `<MenuItem onClick={${handler}}>Action</MenuItem>`;
      expect(inspect(bad, "fixture.tsx")).toEqual(["fixture.tsx:1"]);
      expect(inspect(protectedFixture(bad), "fixture.tsx")).toEqual([]);
      expect(
        inspect(`<CapabilityAction>${bad}</CapabilityAction>`, "fixture.tsx"),
      ).toEqual(["fixture.tsx:1"]);
      expect(
        inspect(
          `<CapabilityAction action={{}}>${bad}</CapabilityAction>`,
          "fixture.tsx",
        ),
      ).toEqual(["fixture.tsx:1"]);
      expect(
        inspect(
          `<CapabilityAction action={{ capability: null }}>${bad}</CapabilityAction>`,
          "fixture.tsx",
        ),
      ).toEqual(["fixture.tsx:1"]);
    }
  });
  test("generic callbacks are admitted by their production owner, not their name alone", () => {
    for (const [file, handler] of [
      ["features/statutes/components/provision-ask-actions.tsx", "summarize"],
      ["components/workspaces/ai-column-run-controls.tsx", "onRun"],
      ["components/inspector/desktop-open-button.tsx", "() => gate.run(open)"],
    ] as const) {
      const bad = `<Button onClick={${handler}}>Action</Button>`;
      expect(inspect(bad, file)).toEqual([`${file}:1`]);
      const good = protectedFixture(bad);
      expect(inspect(good, file)).toEqual([]);
      expect(inspect(bad, "unrelated.tsx")).toEqual([]);
    }
    const summary = `const SearchSummaryItem = () => <Button onClick={onClick}>Summary</Button>`;
    expect(inspect(summary, "components/search-dialog-results.tsx")).toEqual([
      "components/search-dialog-results.tsx:1",
    ]);
  });
  test("removing admission from each production-shaped surface reveals the missing descriptor", () => {
    for (const [file, element, handler] of [
      ["components/workspaces/row-actions.tsx", "MenuItem", "onTranslate"],
      [
        "components/workspaces/row-actions.tsx",
        "MenuItem",
        "() => detached(onRun(source), 'row-actions.run-ocr')",
      ],
      ["components/chat/chat-selection-toolbar.tsx", "Button", "quoteInReply"],
      [
        "components/inspector/desktop-open-button.tsx",
        "ToolbarIconAction",
        "() => gate.run(open)",
      ],
      [
        "features/statutes/components/provision-ask-actions.tsx",
        "Button",
        "summarize",
      ],
      ["components/chat/composer-plus-menu.tsx", "MenuItem", "onNewThread"],
    ] as const) {
      const child = `<${element} onClick={${handler}}>Action</${element}>`;
      const protectedSource = protectedFixture(child);
      expect(inspect(protectedSource, file)).toEqual([]);
      expect(inspect(child, file)).toEqual([`${file}:1`]);
    }
  });
  test("every callback forwards admission overrides last even for unrecognized handlers", () => {
    const good = protectedFixture(
      "<Button onClick={unrecognizedFlow}>Action</Button>",
    );
    expect(inspect(good, "fixture.tsx")).toEqual([]);
    for (const bad of [
      good.replace(" {...capabilityProps}", ""),
      good.replace(
        " {...capabilityProps}",
        " {...capabilityProps} onClick={unrecognizedFlow}",
      ),
      good.replace(" {...capabilityProps}", " {...otherProps}"),
    ]) {
      expect(inspect(bad, "fixture.tsx")).toEqual(["fixture.tsx:1"]);
    }
  });
  test("data-driven registry callbacks also require a non-null descriptor", () => {
    const bad = `const actions = [{ titleKey: "chat.newChat", run: (ctx) => ctx.openNewChat() }];`;
    expect(inspect(bad, "registry.ts")).toEqual(["registry.ts:1"]);
    expect(
      inspect(
        bad.replace("titleKey:", 'capability: "ai", titleKey:'),
        "registry.ts",
      ),
    ).toEqual([]);
  });
  test(
    "every web action opening a capability-dependent flow declares admission",
    () => {
      const root = new URL("../../../", import.meta.url);
      const files = [
        ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root.pathname }),
      ].filter((file) => !file.includes(".test.") && !file.includes("/dev/"));
      expect(files.length).toBeGreaterThan(100);
      const missing = files.flatMap((file) =>
        inspect(readFileSync(new URL(file, root), "utf-8"), file),
      );
      expect(missing).toEqual([]);
    },
    SOURCE_INVENTORY_TIMEOUT_MS,
  );
});
