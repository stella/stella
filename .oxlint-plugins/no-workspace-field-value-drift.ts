import {
  getPropertyName,
  isIdentifier,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const DISPLAY_FIELD_TYPES = new Set([
  "text",
  "date",
  "int",
  "single-select",
  "multi-select",
  "clip",
]);

const BIDI_TEXT_COMPONENTS = new Set(["BidiText", "UserText"]);

const isMemberLike = (node) =>
  node?.type === "MemberExpression" ||
  node?.type === "OptionalMemberExpression";

const jsxElementName = (name) => {
  if (name?.type === "JSXIdentifier") {
    return name.name;
  }

  return null;
};

const getJsxAttr = (node, name) =>
  node.attributes.find(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name?.type === "JSXIdentifier" &&
      attr.name.name === name,
  );

const literalAttrValue = (attr) => {
  if (!attr?.value) {
    return undefined;
  }

  if (attr.value.type === "Literal") {
    return attr.value.value;
  }

  if (
    attr.value.type === "JSXExpressionContainer" &&
    attr.value.expression?.type === "Literal"
  ) {
    return attr.value.expression.value;
  }

  return undefined;
};

const rootIdentifierName = (node) => {
  const unwrapped = unwrapExpression(node);

  if (isIdentifier(unwrapped)) {
    return unwrapped.name;
  }

  if (!isMemberLike(unwrapped)) {
    return null;
  }

  return rootIdentifierName(unwrapped.object);
};

const isPropertyContentAccess = (node) => {
  const rootName = rootIdentifierName(node);
  return rootName === "property" || rootName?.endsWith("Property") === true;
};

const isFieldContentObject = (node) => {
  const unwrapped = unwrapExpression(node);

  if (isIdentifier(unwrapped)) {
    return (
      unwrapped.name === "content" ||
      unwrapped.name === "fieldContent" ||
      unwrapped.name.endsWith("FieldContent")
    );
  }

  if (!isMemberLike(unwrapped)) {
    return false;
  }

  if (getPropertyName(unwrapped.property) !== "content") {
    return false;
  }

  return !isPropertyContentAccess(unwrapped);
};

const isFieldContentTypeAccess = (node) => {
  const unwrapped = unwrapExpression(node);

  if (!isMemberLike(unwrapped)) {
    return false;
  }

  return (
    getPropertyName(unwrapped.property) === "type" &&
    isFieldContentObject(unwrapped.object)
  );
};

const literalDisplayFieldType = (node) => {
  const unwrapped = unwrapExpression(node);

  if (!isStringLiteral(unwrapped)) {
    return null;
  }

  return DISPLAY_FIELD_TYPES.has(unwrapped.value) ? unwrapped.value : null;
};

const comparisonFieldType = (node, aliases) => {
  if (
    node.type !== "BinaryExpression" ||
    !["==", "===", "!=", "!=="].includes(node.operator)
  ) {
    return null;
  }

  const leftLiteral = literalDisplayFieldType(node.left);
  const rightLiteral = literalDisplayFieldType(node.right);

  if (leftLiteral && isFieldTypeExpression(node.right, aliases)) {
    return leftLiteral;
  }

  if (rightLiteral && isFieldTypeExpression(node.left, aliases)) {
    return rightLiteral;
  }

  return null;
};

const isFieldTypeExpression = (node, aliases) => {
  const unwrapped = unwrapExpression(node);

  return (
    isFieldContentTypeAccess(unwrapped) ||
    (isIdentifier(unwrapped) && aliases.has(unwrapped.name))
  );
};

export default {
  meta: { name: "no-workspace-field-value-drift" },
  rules: {
    "no-workspace-field-value-drift": {
      meta: {
        type: "problem",
        messages: {
          noWorkspaceFieldValueDrift:
            'Workspace field value display for "{{type}}" must go through <FieldValue /> or <EditableField />. Keep surface behavior local, but do not reimplement field-type rendering branches.',
        },
      },
      create(context) {
        const fieldTypeAliases = new Set();

        return {
          VariableDeclarator(node) {
            if (
              !isIdentifier(node.id) ||
              !isFieldContentTypeAccess(node.init)
            ) {
              return;
            }

            fieldTypeAliases.add(node.id.name);
          },

          BinaryExpression(node) {
            const type = comparisonFieldType(node, fieldTypeAliases);

            if (!type) {
              return;
            }

            context.report({
              node,
              messageId: "noWorkspaceFieldValueDrift",
              data: { type },
            });
          },

          SwitchCase(node) {
            const parent = node.parent;

            if (
              !parent ||
              parent.type !== "SwitchStatement" ||
              !isFieldTypeExpression(parent.discriminant, fieldTypeAliases)
            ) {
              return;
            }

            const type = literalDisplayFieldType(node.test);

            if (!type) {
              return;
            }

            context.report({
              node,
              messageId: "noWorkspaceFieldValueDrift",
              data: { type },
            });
          },
        };
      },
    },
    "no-raw-field-value-bidi-text": {
      meta: {
        type: "problem",
        messages: {
          noRawFieldValueBidiText:
            'Workspace field value text with `dir="auto"` must use <BidiText /> so bidi isolation stays attached.',
        },
      },
      create(context) {
        return {
          JSXOpeningElement(node) {
            const elementName = jsxElementName(node.name);
            const dirAttr = getJsxAttr(node, "dir");

            if (
              !elementName ||
              BIDI_TEXT_COMPONENTS.has(elementName) ||
              literalAttrValue(dirAttr) !== "auto"
            ) {
              return;
            }

            context.report({
              node: dirAttr ?? node,
              messageId: "noRawFieldValueBidiText",
            });
          },
        };
      },
    },
  },
};
