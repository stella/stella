// User avatars must render through UserAvatar or UserIdentity. Six user
// surfaces composed the raw Avatar primitive and independently rebuilt
// initials, display-name fallbacks, image alternatives, deleted styling, or
// hover labels; those copies therefore produced different identities for the
// same account.
//
// The ban is deliberately scoped to imports from the avatar primitive module.
// Anonymous sign-in, organization identity, the component gallery, and DOCX
// author shortcuts are explicit file exceptions because they are not user
// identities. The `raw-user-avatar-primitive` ratchet metric covers aliases or
// indirect imports the module-level AST rule cannot identify.

import type { AstNode } from "./utils.ts";
import {
  filenameForContext,
  getImportedName,
  isStringLiteral,
} from "./utils.ts";

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
  report: (diagnostic: {
    node: unknown;
    messageId: "rawAvatar";
    data: { name: string };
  }) => void;
};

const AVATAR_MODULE = "@stll/ui/components/avatar";
const ALLOWED_FILES = [
  "apps/web/src/components/user-avatar.tsx",
  "apps/web/src/components/public-workspace-shell.tsx",
  "apps/web/src/routes/auth/organization.tsx",
  "apps/web/src/routes/dev/-components/ui-playground.tsx",
  "apps/web/src/components/ai-suggestions/review-panel.impl.tsx",
];

export default {
  meta: { name: "no-raw-user-avatar-primitive" },
  rules: {
    "no-raw-user-avatar-primitive": {
      meta: {
        type: "problem",
        messages: {
          rawAvatar:
            "Do not import {{name}} from the raw avatar primitive here. " +
            "Render UserAvatar or UserIdentity from " +
            "'@/components/user-avatar' instead.",
        },
      },
      create(context: RuleContext) {
        const filename = filenameForContext(context);
        if (
          !filename.includes("apps/web/src/") &&
          !filename.endsWith(
            ".oxlint-plugins/__fixtures__/no-raw-user-avatar-primitive.fixture.tsx",
          )
        ) {
          return {};
        }
        if (ALLOWED_FILES.some((allowed) => filename.endsWith(allowed))) {
          return {};
        }
        return {
          ImportDeclaration(node: AstNode) {
            const source = node.source;
            if (
              !isStringLiteral(source) ||
              source.value !== AVATAR_MODULE ||
              !Array.isArray(node.specifiers)
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              const name = getImportedName(specifier);
              if (name !== null) {
                context.report({
                  node: specifier,
                  messageId: "rawAvatar",
                  data: { name },
                });
              }
            }
          },
        };
      },
    },
  },
};
