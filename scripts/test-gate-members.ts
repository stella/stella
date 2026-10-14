import ts from "typescript";

export const literalMemberName = (node: ts.Node): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (!ts.isElementAccessExpression(node)) {
    return undefined;
  }
  const argument = node.argumentExpression;
  return argument !== undefined &&
    (ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
};

export const literalPropertyName = (
  node: ts.PropertyName,
): string | undefined => {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
};
