import ts from "typescript6";

export const unwrapTransparentExpression = (
  expression: ts.Expression,
): ts.Expression => {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  return node;
};

export const literalMemberName = (
  expression: ts.Expression,
): string | undefined => {
  const node = unwrapTransparentExpression(expression);
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (!ts.isElementAccessExpression(node)) {
    return undefined;
  }
  const argument = unwrapTransparentExpression(node.argumentExpression);
  return ts.isStringLiteral(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument)
    ? argument.text
    : undefined;
};

export const literalPropertyName = (
  input: ts.PropertyName,
): string | undefined => {
  const node = ts.isComputedPropertyName(input)
    ? unwrapTransparentExpression(input.expression)
    : input;
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
};
