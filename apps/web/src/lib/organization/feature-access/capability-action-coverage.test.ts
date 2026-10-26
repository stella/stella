import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  type JSXElement,
  type JSXOpeningElement,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  type ParamPattern,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const SOURCE_INVENTORY_TIMEOUT_MS = 30_000;

// Event handlers are inspected as syntax nodes: labels and imports cannot satisfy admission.
const dependentFlow =
  /onTranslate|openTranslation|setTranslation|handleRunOcr|run-ocr|queueOcr|onSign\b|pdfSignFlow\.start|onOpenInDesktop|onChatAbout|insertIntoChat|askInChat|onAskAI|sendToChat|runPropertyRows|runSelectedAIColumns|verifyList|openNewChat|askAboutPassage|askInNewChat|quoteInReply|insertChatMention|onNewThread|handleCreateAvt|askAboutThis|onOpenChat/iu;
const actionElement =
  /^(MenuItem|ContextMenuItem|DropdownMenuItem|Button|IconButton|CommandItem|ResponsiveActionButton|ToolbarIconAction|BuiltInTemplateRow)$/u;
const protectedFixture = (child: string) =>
  `<CapabilityAction action={{ capability: "ai" }}>{(capabilityProps) => (${child.replace(">Action", " {...capabilityProps}>Action")})}</CapabilityAction>`;
/** `<Tag>…</Tag>`; oxc also wraps a self-closing `<Tag />` in a JSXElement. */
const isPairedElement = (node: Node): node is JSXElement =>
  node.type === "JSXElement" && node.closingElement !== null;
/** The parameter's own name, through a default value or a rest marker. */
const parameterName = (parameter: ParamPattern | undefined) => {
  let binding: Node | undefined = parameter;
  if (parameter?.type === "AssignmentPattern") {
    binding = parameter.left;
  } else if (parameter?.type === "RestElement") {
    binding = parameter.argument;
  }
  return binding?.type === "Identifier" ? binding.name : undefined;
};
const isNullLiteral = (node: Node) =>
  node.type === "Literal" && node.raw === "null";
const inspect = (source: string, fileName: string) => {
  const parsed = parseSource(fileName, source);
  const textOf = (node: Node) => source.slice(node.start, node.end);
  const location = (node: Node) =>
    `${fileName}:${parsed.locate(node.start).line}`;
  const tagOf = (element: JSXOpeningElement) => textOf(element.name);
  // `key: value` entries only, as TypeScript's PropertyAssignment: no
  // shorthand, method or accessor. A computed key keeps its brackets.
  const assignments = (object: ObjectExpression) =>
    object.properties.flatMap((property) =>
      property.type === "Property" &&
      property.kind === "init" &&
      !property.method &&
      !property.shorthand
        ? [property]
        : [],
    );
  const keyOf = (property: ObjectProperty) =>
    property.computed ? `[${textOf(property.key)}]` : textOf(property.key);
  const declaresCapability = (object: ObjectExpression) =>
    assignments(object).some(
      (property) =>
        keyOf(property) === "capability" && !isNullLiteral(property.value),
    );
  const missing: string[] = [];
  walk(parsed.program, (node, ancestors) => {
    if (
      isPairedElement(node) &&
      tagOf(node.openingElement) === "CapabilityAction"
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
        const parameter = parameterName(callback.params.at(0));
        let body = callback.body;
        while (body.type === "ParenthesizedExpression") {
          body = body.expression;
        }
        const last =
          body.type === "JSXElement"
            ? body.openingElement.attributes.at(-1)
            : undefined;
        forwardsLast =
          parameter !== undefined &&
          last?.type === "JSXSpreadAttribute" &&
          last.argument.type === "Identifier" &&
          last.argument.name === parameter;
      }
      if (!forwardsLast) {
        missing.push(location(node));
      }
    }
    if (node.type === "JSXOpeningElement" && actionElement.test(tagOf(node))) {
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
          return (
            fileName.endsWith("search-dialog-results.tsx") &&
            /\bonClick\b/u.test(text) &&
            ancestors.some(
              (owner) =>
                owner.type === "VariableDeclarator" &&
                owner.id.type === "Identifier" &&
                owner.id.name === "SearchSummaryItem",
            )
          );
        })
      ) {
        let declared =
          tagOf(node) === "BuiltInTemplateRow" &&
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
            isPairedElement(parent) &&
            tagOf(parent.openingElement) === "CapabilityAction"
          ) {
            declared = parent.openingElement.attributes.some((attribute) => {
              if (
                attribute.type !== "JSXAttribute" ||
                textOf(attribute.name) !== "action" ||
                attribute.value?.type !== "JSXExpressionContainer" ||
                attribute.value.expression.type === "JSXEmptyExpression"
              ) {
                return false;
              }
              const expression = attribute.value.expression;
              return (
                expression.type !== "ObjectExpression" ||
                declaresCapability(expression)
              );
            });
            break;
          }
        }
        if (!declared) {
          missing.push(location(node));
        }
      }
    }
    if (node.type === "ObjectExpression") {
      const properties = assignments(node);
      const callbacks = properties.filter((property) =>
        /^(run|onClick|onSelect)$/u.test(keyOf(property)),
      );
      const actionShape = properties.some((property) =>
        /^(label|titleKey)$/u.test(keyOf(property)),
      );
      if (
        actionShape &&
        callbacks.some((callback) => dependentFlow.test(textOf(callback))) &&
        !declaresCapability(node)
      ) {
        missing.push(location(node));
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
