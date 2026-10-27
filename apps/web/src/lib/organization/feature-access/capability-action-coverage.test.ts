import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

const SOURCE_INVENTORY_TIMEOUT_MS = 30_000;

// Event handlers are inspected as syntax nodes: labels and imports cannot satisfy admission.
const dependentFlow =
  /onTranslate|openTranslation|setTranslation|handleRunOcr|run-ocr|queueOcr|onSign\b|pdfSignFlow\.start|onOpenInDesktop|onChatAbout|insertIntoChat|askInChat|onAskAI|sendToChat|runPropertyRows|runSelectedAIColumns|verifyList|openNewChat|askAboutPassage|askInNewChat|quoteInReply|insertChatMention|onNewThread|handleCreateAvt|askAboutThis|onOpenChat/iu;
const actionElement =
  /^(MenuItem|ContextMenuItem|DropdownMenuItem|Button|IconButton|CommandItem|ResponsiveActionButton|ToolbarIconAction|BuiltInTemplateRow)$/u;
const protectedFixture = (child: string) =>
  `<CapabilityAction action={{ capability: "ai" }}>{(capabilityProps) => (${child.replace(">Action", " {...capabilityProps}>Action")})}</CapabilityAction>`;
const inspect = (source: string, fileName: string) => {
  const file = parseSource(fileName, source);
  const textOf = (node: Node) => source.slice(node.start, node.end);
  const missing: string[] = [];
  walk(file.program, (node, ancestors) => {
    if (
      node.type === "JSXElement" &&
      !node.openingElement.selfClosing &&
      textOf(node.openingElement.name) === "CapabilityAction"
    ) {
      const expression = node.children.find(
        (child) =>
          child.type === "JSXExpressionContainer" &&
          child.expression.type !== "JSXEmptyExpression",
      );
      let forwardsLast = false;
      if (
        expression?.type === "JSXExpressionContainer" &&
        expression.expression.type === "ArrowFunctionExpression"
      ) {
        const callback = expression.expression;
        const parameter = callback.params.at(0);
        let body = callback.body;
        while (body.type === "ParenthesizedExpression") {
          body = body.expression;
        }
        const opening = (() => {
          if (body.type === "JSXElement") {
            return body.openingElement;
          }
          return undefined;
        })();
        const last = opening?.attributes.at(-1);
        forwardsLast =
          parameter?.type === "Identifier" &&
          last?.type === "JSXSpreadAttribute" &&
          last.argument.type === "Identifier" &&
          last.argument.name === parameter.name;
      }
      if (!forwardsLast) {
        missing.push(`${fileName}:${file.locate(node.start).line}`);
      }
    }
    if (
      node.type === "JSXOpeningElement" &&
      actionElement.test(textOf(node.name))
    ) {
      const handlers = node.attributes.filter(
        (attribute) =>
          attribute.type === "JSXAttribute" &&
          /^(onClick|onSelect|onUse)$/u.test(textOf(attribute.name)),
      );
      if (
        handlers.some((handler) => {
          const text = textOf(handler);
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
            return ancestors.some(
              (owner) =>
                owner.type === "VariableDeclarator" &&
                textOf(owner.id) === "SearchSummaryItem",
            );
          }
          return false;
        })
      ) {
        let declared =
          textOf(node.name) === "BuiltInTemplateRow" &&
          node.attributes.some(
            (attribute) =>
              attribute.type === "JSXAttribute" &&
              textOf(attribute.name) === "capability" &&
              attribute.value !== null,
          );
        for (const parent of ancestors.toReversed()) {
          if (declared) {
            break;
          }
          if (
            parent.type === "JSXElement" &&
            textOf(parent.openingElement.name) === "CapabilityAction"
          ) {
            declared = parent.openingElement.attributes.some((attribute) => {
              if (
                attribute.type !== "JSXAttribute" ||
                textOf(attribute.name) !== "action" ||
                attribute.value === null
              ) {
                return false;
              }
              if (
                attribute.value.type !== "JSXExpressionContainer" ||
                attribute.value.expression.type === "JSXEmptyExpression"
              ) {
                return false;
              }
              const expression = attribute.value.expression;
              if (expression.type !== "ObjectExpression") {
                return true;
              }
              return expression.properties.some(
                (property) =>
                  property.type === "Property" &&
                  !property.computed &&
                  !property.method &&
                  !property.shorthand &&
                  property.kind === "init" &&
                  textOf(property.key) === "capability" &&
                  !(
                    property.value.type === "Literal" &&
                    property.value.value === null
                  ),
              );
            });
            break;
          }
        }
        if (!declared) {
          missing.push(`${fileName}:${file.locate(node.start).line}`);
        }
      }
    }
    if (node.type === "ObjectExpression") {
      const callbacks = node.properties.filter(
        (property) =>
          property.type === "Property" &&
          !property.computed &&
          !property.method &&
          !property.shorthand &&
          property.kind === "init" &&
          /^(run|onClick|onSelect)$/u.test(textOf(property.key)),
      );
      const actionShape = node.properties.some(
        (property) =>
          property.type === "Property" &&
          !property.computed &&
          !property.method &&
          !property.shorthand &&
          property.kind === "init" &&
          /^(label|titleKey)$/u.test(textOf(property.key)),
      );
      if (
        actionShape &&
        callbacks.some((callback) => dependentFlow.test(textOf(callback)))
      ) {
        const declared = node.properties.some(
          (property) =>
            property.type === "Property" &&
            !property.computed &&
            !property.method &&
            !property.shorthand &&
            property.kind === "init" &&
            textOf(property.key) === "capability" &&
            !(
              property.value.type === "Literal" && property.value.value === null
            ),
        );
        if (!declared) {
          missing.push(`${fileName}:${file.locate(node.start).line}`);
        }
      }
    }
  });
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
