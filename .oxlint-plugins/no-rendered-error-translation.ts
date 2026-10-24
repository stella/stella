import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isAstNode, staticStringValue } from "./utils.ts";

const OWNERS = [
  "apps/web/src/lib/errors/user-toast.ts",
  // Shared, retryable case-law analysis status surface.
  "apps/web/src/features/case-law/components/case-viewer/analysis/analysis-error-notice.tsx",
  // Existing scoped status and validation surfaces. They own recovery in place;
  // listing exact modules keeps new raw renderers fail-closed.
  "apps/web/src/components/bilingual-run-panel.tsx",
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
  "apps/web/src/routes/_protected.admin/-components/organization/number-series-preview.tsx",
  "apps/web/src/routes/_protected.admin/-components/organization/number-series-seller-picker.tsx",
  "apps/web/src/routes/_protected.admin/-components/organization/seller-profile-refusal.tsx",
  "apps/web/src/routes/_protected.admin/-components/organization/vat-rate-display.tsx",
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
    return staticStringValue(attribute.value);
  }
  return null;
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
            while (isAstNode(parent) && parent.type !== "JSXElement") {
              parent = parent.parent;
            }
            if (!isAstNode(parent) || parent.type !== "JSXElement") {
              return;
            }
            const role = attributeValue(parent.openingElement, "role");
            const className = attributeValue(
              parent.openingElement,
              "className",
            );
            if (role === "alert" || className?.includes("text-destructive")) {
              context.report({ node: parent, messageId: "owned" });
            }
          },
        };
      },
    },
  },
});
