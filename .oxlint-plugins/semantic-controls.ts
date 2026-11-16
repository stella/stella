// Virtual context-menu anchors are registered only by MenuAnchor. Hidden raw
// triggers otherwise inherit Base UI's focusable button defaults.
// Icon controls in workspace-ui must name their action through a dedicated
// label; direct common.add/common.edit translations and labels.add/labels.edit
// are ambiguous. This syntactic guard also checks inline labels at SortChips
// call sites. It does not resolve arbitrary translation helpers or data flow.
import { type Context, eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  everyNode,
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  jsxName,
  memberPropertyName,
  resolveVariable,
  stableInitializer,
  staticStringValue,
} from "./utils.ts";

const GENERIC_LABEL_KEYS = new Set(["common.add", "common.edit"]);
const GENERIC_LABEL_FIELDS = new Set(["add", "edit"]);
const TARGET_OWNERSHIP_CHECKS = new Set(["contextMenuBelongsTo"]);

const attributeOf = (opening: AstNode, name: string) =>
  Array.isArray(opening.attributes)
    ? opening.attributes.find(
        (attribute): attribute is AstNode =>
          isAstNode(attribute) &&
          attribute.type === "JSXAttribute" &&
          jsxName(attribute.name) === name,
      )
    : undefined;

const valueOf = (attribute: AstNode | undefined) => {
  const value = attribute?.value;
  return isAstNode(value) && value.type === "JSXExpressionContainer"
    ? value.expression
    : value;
};

const hasHiddenAttribute = (opening: AstNode) =>
  Array.isArray(opening.attributes) &&
  opening.attributes.some((node) => {
    if (node.type !== "JSXAttribute") {
      return false;
    }
    const name = jsxName(node.name);
    return (
      name === "hidden" ||
      name === "aria-hidden" ||
      (name === "className" &&
        (staticStringValue(valueOf(node)) ?? "")
          .split(/\s+/u)
          .some((token) => token === "sr-only" || token === "hidden"))
    );
  });

const hasHiddenAnchor = (opening: AstNode) => {
  if (hasHiddenAttribute(opening)) {
    return true;
  }
  const render = valueOf(attributeOf(opening, "render"));
  return (
    isAstNode(render) &&
    render.type === "JSXElement" &&
    isAstNode(render.openingElement) &&
    hasHiddenAttribute(render.openingElement)
  );
};

const hasGenericLabel = (value: unknown) =>
  everyNode(value).some((node) => {
    if (node.type === "CallExpression" && Array.isArray(node.arguments)) {
      const key = staticStringValue(node.arguments.at(0));
      return key !== null && GENERIC_LABEL_KEYS.has(key);
    }
    return (
      node.type === "MemberExpression" &&
      GENERIC_LABEL_FIELDS.has(memberPropertyName(node) ?? "")
    );
  });

const isIconControl = (opening: AstNode) => {
  const size = staticStringValue(valueOf(attributeOf(opening, "size")));
  if (size?.startsWith("icon")) {
    return true;
  }
  return everyNode(valueOf(attributeOf(opening, "render"))).some(
    (node) =>
      node.type === "JSXOpeningElement" &&
      (staticStringValue(valueOf(attributeOf(node, "size"))) ?? "").startsWith(
        "icon",
      ),
  );
};

// Follow stable local handlers, including a callback handed to a containment
// wrapper. Import resolution also handles aliases and namespace imports, while
// rejecting an unrelated local function that only shares the predicate's name.
const checksContextMenuTarget = (context: Context, handler: unknown) => {
  const pending = everyNode(handler);
  const seen = new Set<AstNode>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || seen.has(node)) {
      continue;
    }
    seen.add(node);
    if (
      node.type === "CallExpression" &&
      isImportedFrom({
        context,
        node: node.callee,
        modules: [
          "@/components/context-menu-target",
          "apps/web/src/components/context-menu-target",
        ],
        names: TARGET_OWNERSHIP_CHECKS,
      })
    ) {
      return true;
    }
    if (isIdentifierReference(node)) {
      const variable = resolveVariable(context, node);
      if (variable !== null) {
        pending.push(...everyNode(stableInitializer(variable)));
      }
    }
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "semantic-controls" },
  rules: {
    "require-context-menu-target": {
      meta: {
        type: "problem",
        messages: {
          resolveTarget:
            "A marked context-menu row must check contextMenuBelongsTo before opening actions, so nested rows cannot invoke an ancestor's menu.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return filenameForContext(context).endsWith(".tsx");
          },
          JSXOpeningElement(node) {
            if (!isAstNode(node)) {
              return;
            }
            if (attributeOf(node, "data-context-menu-target") === undefined) {
              return;
            }
            const handler = attributeOf(node, "onContextMenu");
            if (
              handler !== undefined &&
              !checksContextMenuTarget(context, valueOf(handler))
            ) {
              context.report({ node: handler, messageId: "resolveTarget" });
            }
          },
        };
      },
    },
    "require-menu-anchor": {
      meta: {
        type: "problem",
        messages: {
          useAnchor:
            "Use MenuAnchor for a hidden context-menu trigger; it excludes the anchor from keyboard focus and the accessibility tree.",
        },
      },
      createOnce(context) {
        const triggers = new Set<string>();
        const namespaces = new Set<string>();
        return {
          before() {
            triggers.clear();
            namespaces.clear();
            return filenameForContext(context).endsWith(".tsx");
          },
          ImportDeclaration(node) {
            if (staticStringValue(node.source) !== "@stll/ui/menu") {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportNamespaceSpecifier" &&
                isIdentifier(specifier.local)
              ) {
                namespaces.add(specifier.local.name);
              }
              const imported = getImportedName(specifier);
              const local = getImportLocalName(specifier);
              if (
                (imported === "MenuTrigger" ||
                  imported === "DropdownMenuTrigger") &&
                local !== null
              ) {
                triggers.add(local);
              }
            }
          },
          JSXOpeningElement(node) {
            if (!isAstNode(node)) {
              return;
            }
            const name = jsxName(node.name);
            const isNamespaceTrigger =
              node.name.type === "JSXMemberExpression" &&
              namespaces.has(jsxName(node.name.object) ?? "") &&
              (name === "MenuTrigger" || name === "DropdownMenuTrigger");
            if (
              (triggers.has(name ?? "") || isNamespaceTrigger) &&
              hasHiddenAnchor(node)
            ) {
              context.report({ node, messageId: "useAnchor" });
            }
          },
        };
      },
    },
    "require-specific-icon-label": {
      meta: {
        type: "problem",
        messages: {
          specificLabel:
            "Name this icon action with a dedicated label (such as addSort), rather than common.add/common.edit or labels.add/labels.edit.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return filenameForContext(context).endsWith(".tsx");
          },
          JSXOpeningElement(node) {
            if (!isAstNode(node)) {
              return;
            }
            const label = attributeOf(node, "aria-label");
            const filename = filenameForContext(context);
            const ownsIconControls =
              filename.includes("packages/workspace-ui/") ||
              filename.includes("semantic-controls.fixture.");
            if (
              ownsIconControls &&
              isIconControl(node) &&
              hasGenericLabel(valueOf(label))
            ) {
              context.report({
                node: label ?? node,
                messageId: "specificLabel",
              });
            }
            // Caller wording crosses a translation boundary before the shared
            // component can see it, so validate the inline dedicated label here.
            if (jsxName(node.name)?.endsWith("SortChips")) {
              const labels = attributeOf(node, "labels");
              if (hasGenericLabel(valueOf(labels))) {
                context.report({
                  node: labels ?? node,
                  messageId: "specificLabel",
                });
              }
            }
          },
        };
      },
    },
  },
});
