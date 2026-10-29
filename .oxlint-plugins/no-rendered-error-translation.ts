import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  staticStringValue,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const OWNERS = [
  "apps/web/src/lib/errors/user-toast.ts",
  // Shared, retryable case-law analysis status surface.
  "apps/web/src/features/case-law/components/case-viewer/analysis/analysis-error-notice.tsx",
  // Existing scoped status and validation surfaces. They own recovery in place;
  // listing exact modules keeps new raw renderers fail-closed.
  "apps/web/src/components/bilingual-run-panel.tsx",
  "apps/web/src/components/chat/connect-connector-card.tsx",
  "apps/web/src/components/chat/request-secret-card.tsx",
  "apps/web/src/components/contact-read-error.tsx",
  "apps/web/src/components/docx/docx-suggestions-query-status.tsx",
  "apps/web/src/components/matter-target-picker.tsx",
  "apps/web/src/components/pdf/page-organizer-crop.tsx",
  "apps/web/src/components/templates/template-ai-conditions.tsx",
  "apps/web/src/components/workspaces/matter-combobox.tsx",
  "apps/web/src/components/workspaces/parties-section.tsx",
  "apps/web/src/features/chat/answer-edit/answer-format-proposal.tsx",
  "apps/web/src/features/chat/answer-edit/answer-revision-history.tsx",
  "apps/web/src/features/command-palette/components/upload-document-dialog.tsx",
  "apps/web/src/features/knowledge/public/tools/tool-contribute-page.tsx",
  "apps/web/src/features/statutes/components/provision-inspector-view.tsx",
  "apps/web/src/features/style-sets/style-set-picker-dialog.tsx",
  "apps/web/src/routes/_protected.settings/organization/-components/organization/number-series-preview.tsx",
  "apps/web/src/routes/_protected.settings/organization/-components/organization/number-series-seller-picker.tsx",
  "apps/web/src/routes/_protected.settings/organization/-components/organization/seller-profile-refusal.tsx",
  "apps/web/src/routes/_protected.settings/organization/-components/organization/vat-rate-display.tsx",
  "apps/web/src/routes/_protected.admin/audit-logs.tsx",
  "apps/web/src/routes/_protected.settings/account.beta.tsx",
  "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/overview-time-read.tsx",
  "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/view/report-export-history.tsx",
  "apps/web/src/routes/knowledge/-components/skill-editor.tsx",
  "apps/web/src/routes/knowledge/-components/template-check-dialog.tsx",
];

const isErrorKey = (value: string): boolean =>
  value === "errors.actionFailed" ||
  value.startsWith("errors.api.") ||
  /(?:Error|Failed)$/.test(value);

const attributeValue = (node: unknown, name: string): string | null => {
  if (!isAstNode(node) || node.type !== "JSXOpeningElement") {
    return null;
  }
  const attributes = Array.isArray(node.attributes) ? node.attributes : [];
  for (const attribute of attributes) {
    if (
      !isAstNode(attribute) ||
      attribute.type !== "JSXAttribute" ||
      !isAstNode(attribute.name) ||
      attribute.name.type !== "JSXIdentifier" ||
      attribute.name.name !== name
    ) {
      continue;
    }
    const value = attribute.value;
    return isAstNode(value) && value.type === "JSXExpressionContainer"
      ? staticStringValue(value.expression)
      : staticStringValue(value);
  }
  return null;
};

const isValueParent = (value: AstNode, parent: AstNode): boolean => {
  switch (parent.type) {
    case "ArrayExpression":
    case "ChainExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return true;
    case "ConditionalExpression":
      return parent.test !== value;
    case "LogicalExpression":
      return parent.operator !== "&&" || parent.left !== value;
    case "JSXExpressionContainer": {
      const container = parent.parent;
      return (
        isAstNode(container) &&
        (container.type === "JSXElement" ||
          container.type === "JSXFragment" ||
          (container.type === "JSXAttribute" &&
            isAstNode(container.name) &&
            container.name.type === "JSXIdentifier" &&
            container.name.name === "children"))
      );
    }
    case "JSXElement":
    case "JSXFragment":
      return Array.isArray(parent.children) && parent.children.includes(value);
    default:
      return false;
  }
};

const returnsTranslation = (
  translation: AstNode,
  callback: AstNode,
): boolean => {
  let value = translation;
  while (isAstNode(value.parent)) {
    const parent = value.parent;
    if (parent === callback) {
      return callback.body === value;
    }
    if (parent.type === "ReturnStatement" && parent.argument === value) {
      let owner = parent.parent;
      while (isAstNode(owner)) {
        if (owner.type === "TryStatement") {
          return false;
        }
        if (
          owner.type === "ArrowFunctionExpression" ||
          owner.type === "FunctionExpression" ||
          owner.type === "FunctionDeclaration"
        ) {
          return owner === callback;
        }
        owner = owner.parent;
      }
      return false;
    }
    if (!isValueParent(value, parent)) {
      return false;
    }
    value = parent;
  }
  return false;
};

// Only inline array projections whose value reaches JSX children cross a
// function boundary. Event attributes and opaque calls are separate channels.
const isRenderedProjection = (
  callback: AstNode,
  translation: AstNode,
): boolean => {
  if (!returnsTranslation(translation, callback)) {
    return false;
  }
  const call = callback.parent;
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !Array.isArray(call.arguments) ||
    call.arguments.at(0) !== callback ||
    !isAstNode(call.callee) ||
    call.callee.type !== "MemberExpression"
  ) {
    return false;
  }
  const method = call.callee.computed
    ? staticStringValue(call.callee.property)
    : getPropertyName(call.callee.property);
  if (method !== "map" && method !== "flatMap") {
    return false;
  }
  let value = call;
  while (isAstNode(value.parent)) {
    const parent = value.parent;
    if (parent.type === "JSXExpressionContainer") {
      return isValueParent(value, parent);
    }
    if (!isValueParent(value, parent)) {
      return false;
    }
    value = parent;
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-rendered-error-translation" },
  rules: {
    "no-rendered-error-translation": {
      meta: {
        type: "problem",
        messages: {
          owned:
            "Route translated failures through notifyUserError or a shared retryable status component.",
        },
      },
      createOnce(context) {
        let allowed = false;
        return {
          before() {
            allowed = OWNERS.some((owner) =>
              filenameForContext(context).endsWith(owner),
            );
          },
          CallExpression(node) {
            if (
              allowed ||
              !isAstNode(node) ||
              !isAstNode(node.callee) ||
              node.callee.type !== "Identifier" ||
              node.callee.name !== "t"
            ) {
              return;
            }
            const key = staticStringValue(node.arguments.at(0));
            if (key === null || !isErrorKey(key)) {
              return;
            }
            let parent: unknown = node.parent;
            while (isAstNode(parent)) {
              if (
                (parent.type === "ArrowFunctionExpression" ||
                  parent.type === "FunctionExpression" ||
                  parent.type === "FunctionDeclaration") &&
                !isRenderedProjection(parent, node)
              ) {
                return;
              }
              if (
                parent.type === "JSXAttribute" &&
                (!isAstNode(parent.name) || parent.name.name !== "children")
              ) {
                return;
              }
              if (parent.type === "JSXElement") {
                const role = attributeValue(parent.openingElement, "role");
                const className = attributeValue(
                  parent.openingElement,
                  "className",
                );
                if (
                  role === "alert" ||
                  className?.includes("text-destructive")
                ) {
                  context.report({ node: parent, messageId: "owned" });
                  return;
                }
              }
              parent = parent.parent;
            }
          },
        };
      },
    },
  },
});
