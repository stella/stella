// A person is chosen through `MemberCombobox`
// (apps/web/src/components/member-combobox.tsx), never a `Select`. A Select
// cannot be searched by typing, so a long member list turns into scrolling,
// and each surface re-implemented its own trigger rendering, "nobody" row and
// exclusion of people who cannot be chosen.
//
// Flagged: a `Select` from `@stll/ui/select` whose subtree renders a user
// identity (`UserIdentity` or `UserIdentityAvatar` from
// `@/components/user-avatar`) or offers an item whose value is a user id:
//   <Select>…<SelectItem value={member.userId}>…</SelectItem>…</Select>
//   <Select>…<SelectItem value={m.user.id}>…</SelectItem>…</Select>
//   <Select>…<SelectItem value={m.user?.id ?? ""}>…</SelectItem>…</Select>
//   <Select>…<UserIdentity name={member.name} />…</Select>
// Allowed: a Select over anything else (a language, a time zone, a role),
// and every person picker built on MemberCombobox.
//
// The detection is syntactic: a person Select whose items carry ids under
// another name and render plain text is outside what this rule can see.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  elementName,
  everyNode,
  getImportedName,
  getImportLocalName,
  getPropertyName,
  isAstNode,
  jsxName,
} from "./utils.ts";
import type { AstNode } from "./utils.ts";

const SELECT_MODULE = "@stll/ui/select";
const IDENTITY_MODULE = "@/components/user-avatar";
const IDENTITY_IMPORTS = new Set(["UserIdentity", "UserIdentityAvatar"]);

const importLocals = (
  program: unknown,
  source: string,
  names: ReadonlySet<string>,
): Map<string, string> => {
  const locals = new Map<string, string>();
  if (!isAstNode(program) || !Array.isArray(program.body)) {
    return locals;
  }
  for (const statement of program.body) {
    if (
      !isAstNode(statement) ||
      statement.type !== "ImportDeclaration" ||
      !isAstNode(statement.source) ||
      statement.source.value !== source ||
      !Array.isArray(statement.specifiers)
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const imported = getImportedName(specifier);
      const local = getImportLocalName(specifier);
      if (imported !== null && local !== null && names.has(imported)) {
        locals.set(local, imported);
      }
    }
  }
  return locals;
};

// `member.userId`, `user.id` and `m.user.id`, optionally chained, and the
// same id behind a fallback (`m.user?.id ?? ""`), either branch of a
// conditional, a type assertion, or a one-argument conversion
// (`String(member.userId)`).
const isUserIdExpression = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  switch (node.type) {
    case "LogicalExpression":
      return isUserIdExpression(node.left) || isUserIdExpression(node.right);
    case "ConditionalExpression":
      return (
        isUserIdExpression(node.consequent) ||
        isUserIdExpression(node.alternate)
      );
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
      return isUserIdExpression(node.expression);
    case "CallExpression":
      return (
        Array.isArray(node.arguments) &&
        node.arguments.length === 1 &&
        isUserIdExpression(node.arguments[0])
      );
    default:
      return isUserIdAccess(node);
  }
};

const isUserIdAccess = (node: AstNode): boolean => {
  let current: unknown = node;
  if (isAstNode(current) && current.type === "ChainExpression") {
    current = current.expression;
  }
  if (
    !isAstNode(current) ||
    current.type !== "MemberExpression" ||
    current.computed === true
  ) {
    return false;
  }
  const property = getPropertyName(current.property);
  if (property === "userId") {
    return true;
  }
  if (property !== "id" || !isAstNode(current.object)) {
    return false;
  }
  const object = current.object;
  if (object.type === "Identifier") {
    return object.name === "user";
  }
  return (
    object.type === "MemberExpression" &&
    object.computed !== true &&
    getPropertyName(object.property) === "user"
  );
};

const valueAttribute = (element: AstNode): unknown => {
  const opening = element.openingElement;
  if (!isAstNode(opening) || !Array.isArray(opening.attributes)) {
    return null;
  }
  for (const attribute of opening.attributes) {
    if (
      isAstNode(attribute) &&
      attribute.type === "JSXAttribute" &&
      jsxName(attribute.name) === "value" &&
      isAstNode(attribute.value) &&
      attribute.value.type === "JSXExpressionContainer"
    ) {
      return attribute.value.expression;
    }
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-person-select" },
  rules: {
    "no-person-select": {
      meta: {
        type: "problem",
        messages: {
          personSelect:
            "Choose a person with MemberCombobox from '@/components/member-combobox', not a Select: a Select cannot be searched by typing, so a long member list turns into scrolling.",
        },
      },
      createOnce(context) {
        let selectLocals = new Map<string, string>();
        let identityLocals = new Map<string, string>();

        return {
          Program(program) {
            selectLocals = importLocals(
              program,
              SELECT_MODULE,
              new Set(["Select", "SelectItem"]),
            );
            identityLocals = importLocals(
              program,
              IDENTITY_MODULE,
              IDENTITY_IMPORTS,
            );
          },
          JSXElement(node) {
            const name = elementName(node);
            if (name === null || selectLocals.get(name) !== "Select") {
              return;
            }
            const choosesPerson = everyNode(node).some((inner) => {
              const innerName = elementName(inner);
              if (innerName === null) {
                return false;
              }
              if (identityLocals.has(innerName)) {
                return true;
              }
              return (
                selectLocals.get(innerName) === "SelectItem" &&
                isUserIdExpression(valueAttribute(inner))
              );
            });
            if (choosesPerson) {
              context.report({ node, messageId: "personSelect" });
            }
          },
        };
      },
    },
  },
});
