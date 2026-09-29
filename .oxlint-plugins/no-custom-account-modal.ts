// One modal asks a reader for an account: `SignInDialog`, which the public
// shell opens through `requestAuth(redirectTo)` and which returns to the page
// afterwards. A gated act calls the account gate (`useRequireAccount`) and
// lets it open that dialog; it never draws a prompt of its own in front of it.
// A second modal that explains the account and then hands over to the real
// one is an extra step on the way in, with wording that drifts from the
// canonical flow.
//
// Detection: a module that renders a modal surface AND reaches an
// account-entry affordance from that modal's code. Either alone is ordinary:
// dialogs are everywhere, and a banner or a button may open the sign-in
// dialog. Together they are a modal whose purpose is getting the reader into
// an account.
//
//   modal surface     a JSX element bound by an import from `@stll/ui/dialog`,
//                     `@stll/ui/alert-dialog`, `@stll/ui/sheet` (or their
//                     `components/` spellings), or the base-ui dialog
//                     primitives underneath them
//   account entry     - a use of `usePublicSignInRequest` /
//                       `PublicSignInRequestContext`, the shell's hand-off to
//                       the sign-in dialog
//                     - an account-entry message key (`auth.signIn`,
//                       `auth.createFreeAccount`, the provider buttons, …)
//                     - `authClient.signIn.*` / `authClient.signUp.*`
//                     - a JSX `to="/auth"` (also `to={"/auth"}` and
//                       ``to={`/auth`}``), the sign-in page itself
//
// "From that modal's code" is judged per top-level declaration: the one that
// renders the modal element, every same-module declaration it references
// (components, hooks, helpers, constants, transitively), and every
// declaration that renders it (transitively), which covers a parent passing
// the hand-off in as a callback. An unrelated sign-in link elsewhere in the
// module does not count.
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
// hand-off in another); an affordance reached through an alias or a computed
// key; a prompt with generic copy that calls `useRequireAccount()`; an
// affordance in a helper that only a renderer of the modal (not the modal's
// own declaration) references; and, the other way, one declaration that
// renders both an ordinary dialog and an unrelated sign-in link, which is
// reported. The rule catches the shape the account gate once shipped.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  getImportedName,
  isAstNode,
  isFileIn,
  isIdentifier,
  isStringLiteral,
  jsxName,
  staticStringValue,
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

/** The local binding an import specifier of any kind introduces. */
const specifierLocalName = (specifier: unknown): string | null =>
  isAstNode(specifier) && isIdentifier(specifier.local)
    ? specifier.local.name
    : null;

/** The identifier a JSX element name starts from: `Dialog.Popup` → `Dialog`. */
const jsxRootName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "JSXIdentifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "JSXMemberExpression") {
    return jsxRootName(node.object);
  }
  return null;
};

/** The statement directly under `Program` that holds `node`. */
const topLevelStatement = (node: unknown): AstNode | null => {
  if (!isAstNode(node)) {
    return null;
  }
  let current = node;
  let parent = current.parent;
  while (isAstNode(parent)) {
    if (parent.type === "Program") {
      return current;
    }
    current = parent;
    parent = current.parent;
  }
  return null;
};

/** The names a top-level statement declares. */
const declaredNames = (statement: AstNode): string[] => {
  const declaration =
    (statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration") &&
    isAstNode(statement.declaration)
      ? statement.declaration
      : statement;
  if (
    (declaration.type === "FunctionDeclaration" ||
      declaration.type === "ClassDeclaration") &&
    isIdentifier(declaration.id)
  ) {
    return [declaration.id.name];
  }
  if (
    declaration.type !== "VariableDeclaration" ||
    !Array.isArray(declaration.declarations)
  ) {
    return [];
  }
  const names: string[] = [];
  for (const declarator of declaration.declarations) {
    if (isAstNode(declarator) && isIdentifier(declarator.id)) {
      names.push(declarator.id.name);
    }
  }
  return names;
};

/** The static text of a JSX attribute value, through `{…}`. */
const jsxAttributeString = (value: unknown): string | null =>
  isAstNode(value) && value.type === "JSXExpressionContainer"
    ? staticStringValue(value.expression)
    : staticStringValue(value);

type Signal = { label: string; statement: AstNode };

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
        const modalLocals = new Set<string>();
        const handoffLocals = new Map<string, string>();
        const modalStatements = new Set<AstNode>();
        const referencesByStatement = new Map<AstNode, Set<string>>();
        const signals: Signal[] = [];

        const noteSignal = (node: unknown, label: string) => {
          const statement = topLevelStatement(node);
          if (statement !== null) {
            signals.push({ label, statement });
          }
        };

        const noteReference = (node: unknown, name: string) => {
          const statement = topLevelStatement(node);
          if (statement === null || statement.type === "ImportDeclaration") {
            return;
          }
          const names = referencesByStatement.get(statement) ?? new Set();
          names.add(name);
          referencesByStatement.set(statement, names);
          const handoff = handoffLocals.get(name);
          if (handoff !== undefined) {
            noteSignal(node, handoff);
          }
        };

        return {
          before() {
            modalImport = null;
            modalLocals.clear();
            handoffLocals.clear();
            modalStatements.clear();
            referencesByStatement.clear();
            signals.length = 0;
            return !isFileIn(context, CANONICAL_OWNERS);
          },
          ImportDeclaration(node) {
            const isModalModule =
              typeof node.source.value === "string" &&
              MODAL_MODULES.has(node.source.value);
            if (isModalModule) {
              modalImport ??= node;
            }
            if (!Array.isArray(node.specifiers)) {
              return;
            }
            for (const specifier of node.specifiers) {
              const local = specifierLocalName(specifier);
              if (local === null) {
                continue;
              }
              if (isModalModule) {
                modalLocals.add(local);
              }
              const imported = getImportedName(specifier);
              if (imported !== null && SIGN_IN_HANDOFFS.has(imported)) {
                handoffLocals.set(local, imported);
              }
            }
          },
          Identifier(node) {
            noteReference(node, node.name);
          },
          JSXIdentifier(node) {
            noteReference(node, node.name);
          },
          JSXOpeningElement(node) {
            const root = jsxRootName(node.name);
            const statement = topLevelStatement(node);
            if (root !== null && modalLocals.has(root) && statement !== null) {
              modalStatements.add(statement);
            }
          },
          Literal(node) {
            if (isStringLiteral(node) && ACCOUNT_ENTRY_KEYS.has(node.value)) {
              noteSignal(node, `"${node.value}"`);
            }
          },
          TemplateLiteral(node) {
            const value = staticStringValue(node);
            if (value !== null && ACCOUNT_ENTRY_KEYS.has(value)) {
              noteSignal(node, `\`${value}\``);
            }
          },
          MemberExpression(node) {
            if (
              !node.computed &&
              isIdentifier(node.object, "authClient") &&
              isIdentifier(node.property) &&
              AUTH_CLIENT_ENTRY_MEMBERS.has(node.property.name)
            ) {
              noteSignal(node, `authClient.${node.property.name}`);
            }
          },
          JSXAttribute(node) {
            if (
              jsxName(node.name) === "to" &&
              jsxAttributeString(node.value) === SIGN_IN_ROUTE
            ) {
              noteSignal(node, `to="${SIGN_IN_ROUTE}"`);
            }
          },
          "Program:exit"() {
            if (!isAstNode(modalImport) || modalStatements.size === 0) {
              return;
            }
            const reach = modalReach({
              modalStatements,
              referencesByStatement,
            });
            const signal = signals.find(({ statement }) =>
              reach.has(statement),
            );
            if (signal === undefined) {
              return;
            }
            context.report({
              node: modalImport,
              messageId: "customAccountModal",
              data: { signal: signal.label },
            });
          },
        };
      },
    },
  },
});

type ModalReachOptions = {
  modalStatements: ReadonlySet<AstNode>;
  referencesByStatement: ReadonlyMap<AstNode, ReadonlySet<string>>;
};

/**
 * The top-level statements that belong to a modal: those rendering it, what
 * they reference (downward), and what renders them (upward), each closed
 * transitively within the module.
 */
const modalReach = ({
  modalStatements,
  referencesByStatement,
}: ModalReachOptions): Set<AstNode> => {
  const statementByName = new Map<string, AstNode>();
  for (const statement of referencesByStatement.keys()) {
    for (const name of declaredNames(statement)) {
      statementByName.set(name, statement);
    }
  }

  const down = new Set(modalStatements);
  const pending = [...modalStatements];
  for (let statement = pending.pop(); statement; statement = pending.pop()) {
    for (const name of referencesByStatement.get(statement) ?? []) {
      const referenced = statementByName.get(name);
      if (referenced !== undefined && !down.has(referenced)) {
        down.add(referenced);
        pending.push(referenced);
      }
    }
  }

  const up = new Set(modalStatements);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [statement, names] of referencesByStatement) {
      if (up.has(statement)) {
        continue;
      }
      const rendersReached = [...up].some((reached) =>
        declaredNames(reached).some((name) => names.has(name)),
      );
      if (rendersReached) {
        up.add(statement);
        grew = true;
      }
    }
  }

  return new Set([...down, ...up]);
};
