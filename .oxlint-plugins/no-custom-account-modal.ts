// One modal asks a reader for an account: `SignInDialog`, which the public
// shell opens through `requestAuth(redirectTo)` and which returns to the page
// afterwards. A gated act calls the account gate (`useRequireAccount`) and
// lets it open that dialog; it never draws a prompt of its own in front of it.
// A second modal that explains the account and then hands over to the real
// one is an extra step on the way in, with wording that drifts from the
// canonical flow.
//
// Detection: a module that imports a modal surface AND reaches an
// account-entry affordance. Either alone is ordinary: dialogs are everywhere,
// and a banner or a button may open the sign-in dialog. Together they are a
// modal whose purpose is getting the reader into an account.
//
//   modal surface     an import from `@stll/ui/dialog`, `@stll/ui/alert-dialog`,
//                     `@stll/ui/sheet` (or their `components/` spellings), or
//                     the base-ui dialog primitives underneath them
//   account entry     - `usePublicSignInRequest` / `PublicSignInRequestContext`,
//                       the shell's hand-off to the sign-in dialog
//                     - an account-entry message key (`auth.signIn`,
//                       `auth.createFreeAccount`, the provider buttons, …)
//                     - `authClient.signIn.*` / `authClient.signUp.*`
//                     - a JSX `to="/auth"`, the sign-in page itself
//
// Chosen over matching every `auth.*` key or every `/auth` target: settings
// dialogs legitimately read `auth.password` and `auth.twoFactor.*`, and the
// protected layout redirects to `/auth` from a module that also draws a sheet.
// The key list names the words that invite a reader to sign in or sign up, and
// only a JSX navigation target counts, not a loader `redirect`.
//
// Allowed: the canonical owner, `apps/web/src/components/auth/sign-in-dialog.tsx`.
//
// Out of scope: a modal composed across modules (the dialog in one file, the
// hand-off in another) and an affordance reached through an alias or a
// computed key. The rule catches the shape the account gate once shipped.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getImportedName,
  isAstNode,
  isFileIn,
  isIdentifier,
  isStringLiteral,
  jsxName,
} from "./utils.ts";

const CANONICAL_OWNERS = ["apps/web/src/components/auth/sign-in-dialog.tsx"];

const MODAL_MODULES = new Set([
  "@base-ui/react/alert-dialog",
  "@base-ui/react/dialog",
  "@stll/ui/alert-dialog",
  "@stll/ui/components/alert-dialog",
  "@stll/ui/components/dialog",
  "@stll/ui/components/sheet",
  "@stll/ui/dialog",
  "@stll/ui/sheet",
]);

const SIGN_IN_HANDOFFS = new Set([
  "PublicSignInRequestContext",
  "usePublicSignInRequest",
]);

const ACCOUNT_ENTRY_KEYS = new Set([
  "auth.continueWithEmail",
  "auth.continueWithGoogle",
  "auth.continueWithMicrosoft",
  "auth.createFirstAccount",
  "auth.createFreeAccount",
  "auth.orSignInWithEmail",
  "auth.signIn",
  "auth.signInWithPassword",
]);

const AUTH_CLIENT_ENTRY_MEMBERS = new Set(["signIn", "signUp"]);

const SIGN_IN_ROUTE = "/auth";

export default eslintCompatPlugin({
  meta: { name: "no-custom-account-modal" },
  rules: {
    "no-custom-account-modal": {
      meta: {
        type: "problem",
        messages: {
          customAccountModal:
            "This module draws a modal and reaches account entry ({{signal}}). " +
            "Do not build an account prompt of your own: call " +
            "`useRequireAccount()` (or `usePublicSignInRequest()` outside a " +
            "modal) so the canonical `SignInDialog` opens directly and returns " +
            "to this page.",
        },
      },
      createOnce(context) {
        let modalImport: unknown = null;
        let signal: string | null = null;

        const noteSignal = (found: string) => {
          signal ??= found;
        };

        return {
          before() {
            modalImport = null;
            signal = null;
            return !isFileIn(context, CANONICAL_OWNERS);
          },
          ImportDeclaration(node) {
            if (
              modalImport === null &&
              typeof node.source.value === "string" &&
              MODAL_MODULES.has(node.source.value)
            ) {
              modalImport = node;
            }
            if (!Array.isArray(node.specifiers)) {
              return;
            }
            for (const specifier of node.specifiers) {
              const imported = getImportedName(specifier);
              if (imported !== null && SIGN_IN_HANDOFFS.has(imported)) {
                noteSignal(imported);
              }
            }
          },
          Literal(node) {
            if (isStringLiteral(node) && ACCOUNT_ENTRY_KEYS.has(node.value)) {
              noteSignal(`"${node.value}"`);
            }
          },
          MemberExpression(node) {
            if (
              !node.computed &&
              isIdentifier(node.object, "authClient") &&
              isIdentifier(node.property) &&
              AUTH_CLIENT_ENTRY_MEMBERS.has(node.property.name)
            ) {
              noteSignal(`authClient.${node.property.name}`);
            }
          },
          JSXAttribute(node) {
            if (
              jsxName(node.name) === "to" &&
              isStringLiteral(node.value) &&
              node.value.value === SIGN_IN_ROUTE
            ) {
              noteSignal(`to="${SIGN_IN_ROUTE}"`);
            }
          },
          "Program:exit"() {
            if (!isAstNode(modalImport) || signal === null) {
              return;
            }
            context.report({
              node: modalImport,
              messageId: "customAccountModal",
              data: { signal },
            });
          },
        };
      },
    },
  },
});
