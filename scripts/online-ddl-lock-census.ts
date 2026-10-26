import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type ArrowFunctionExpression,
  type CallExpression,
  isObjectLiteralProperty,
  type Node,
  type ObjectProperty,
  type ParsedSource,
  parseSource,
  type SpreadElement,
  type TSType,
  type VariableDeclarator,
  walk,
} from "../packages/scripts/src/syntax-tree.ts";
import { parseMigrationStatements } from "./check-migration-safety";
import {
  censusSql,
  DDL_FORMS,
  isWriterBlockingLock,
} from "./migration-lock-census";

const OWNER_PATH = "apps/api/src/db/online-ddl.ts";
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const SQL_START =
  /^\s*(?:DO|PERFORM|CREATE|ALTER|DROP|REINDEX|ANALYZE|COMMENT|TRUNCATE|REFRESH|CLUSTER|VACUUM|GRANT|REVOKE|LOCK|SECURITY|IMPORT|REASSIGN)\b/iu;
const IDENTIFIER_PLACEHOLDER = '"__online_ddl_identifier__"';

type SqlVariant = { node: Node };
type ExpandedSqlVariant = { text: string; resolved: boolean };
type SourceContext = {
  source: ParsedSource;
  /** Every node in source order. */
  nodes: readonly Node[];
  /** oxc nodes carry no parent links. */
  parents: ReadonlyMap<Node, Node>;
};

type TemplateInterpolationAllowance = {
  shape: string;
  reason: string;
  expand: (node: Node) => ExpandedSqlVariant[] | undefined;
};

const isSql = (text: string): boolean => SQL_START.test(text);

const nodeText = (node: Node, source: ParsedSource): string =>
  source.sourceText.slice(node.start, node.end);

// A string literal or a template without substitutions (TypeScript's
// StringLiteralLike), read as its cooked text.
const stringLiteralText = (node: Node | null): string | undefined => {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

const isCallTo = (
  node: Node,
  names: readonly string[],
): node is CallExpression =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  names.includes(node.callee.name);

/** `node` and its ancestors, nearest first. */
const ancestry = (node: Node, context: SourceContext): Node[] => {
  const chain: Node[] = [];
  for (
    let current: Node | undefined = node;
    current !== undefined;
    current = context.parents.get(current)
  ) {
    chain.push(current);
  }
  return chain;
};

const nearestArrow = (
  node: Node,
  context: SourceContext,
): ArrowFunctionExpression | undefined => {
  for (const current of ancestry(node, context)) {
    if (current.type === "ArrowFunctionExpression") {
      return current;
    }
  }
  return undefined;
};

// A parameter's bound name, with or without a default value.
const parameterIdentifier = (parameter: Node) => {
  const binding =
    parameter.type === "AssignmentPattern" ? parameter.left : parameter;
  return binding.type === "Identifier" ? binding : undefined;
};

const variableDeclarator = (
  node: Node,
  name: string,
): VariableDeclarator | undefined =>
  node.type === "VariableDeclarator" &&
  node.id.type === "Identifier" &&
  node.id.name === name
    ? node
    : undefined;

// A `key: value` object literal entry (TypeScript's PropertyAssignment).
const isPropertyAssignment = (
  property: ObjectProperty | SpreadElement,
): property is ObjectProperty =>
  property.type === "Property" &&
  !property.shorthand &&
  !property.method &&
  property.kind === "init";

const isShorthandProperty = (
  property: ObjectProperty | SpreadElement,
): property is ObjectProperty =>
  property.type === "Property" && property.shorthand;

// The key as written, brackets included for a computed key.
const propertyKeyText = (
  property: ObjectProperty | SpreadElement,
  source: ParsedSource,
): string | undefined => {
  if (property.type !== "Property") {
    return undefined;
  }
  const text = nodeText(property.key, source);
  return property.computed ? `[${text}]` : text;
};

export const TEMPLATE_INTERPOLATION_ALLOWLIST: TemplateInterpolationAllowance[] =
  [
    {
      shape: "quoteIdentifier(...) call",
      reason:
        "quoteIdentifier returns one validated, double-quoted PostgreSQL identifier.",
      expand: (node) =>
        isCallTo(node, ["quoteIdentifier"]) && node.arguments.length === 1
          ? [{ text: IDENTIFIER_PLACEHOLDER, resolved: true }]
          : undefined,
    },
    {
      shape: "conditional with literal-only branches",
      reason:
        "Literal branches are enumerated independently and cannot inject uninspected SQL.",
      expand: (node) => {
        if (node.type !== "ConditionalExpression") {
          return undefined;
        }
        const whenTrue = stringLiteralText(node.consequent);
        const whenFalse = stringLiteralText(node.alternate);
        return whenTrue !== undefined && whenFalse !== undefined
          ? [
              { text: whenTrue, resolved: true },
              { text: whenFalse, resolved: true },
            ]
          : undefined;
      },
    },
  ];

// A node's syntax without positions or spelling: its type, its scalar fields
// (names, cooked literal values, operators, flags) and its children's shapes.
const syntaxShape = (node: Node): string => {
  const children: string[] = [];
  walk(node, (child) => {
    if (child === node) {
      return undefined;
    }
    children.push(syntaxShape(child));
    return "skip-children";
  });
  const fields: unknown[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "start" ||
      key === "end" ||
      key === "raw" ||
      // The proofs have never distinguished let, const and var.
      (node.type === "VariableDeclaration" && key === "kind")
    ) {
      continue;
    }
    if (typeof value === "bigint") {
      fields.push(key, String(value));
    } else if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      fields.push(key, value);
    }
  }
  if (node.type === "TemplateElement") {
    fields.push("cooked", node.value.cooked);
  }
  if (node.type === "Literal" && "regex" in node) {
    fields.push("regex", node.regex.pattern, node.regex.flags);
  }
  return JSON.stringify([fields, children]);
};

const sameSyntax = (node: Node, expression: string): boolean => {
  const isBlock = node.type === "BlockStatement";
  const fixture = parseSource(
    "proof.ts",
    `const proof = ${isBlock ? `() => ${expression}` : expression};`,
  );
  const statement = fixture.program.body.at(0);
  const initializer =
    statement?.type === "VariableDeclaration"
      ? (statement.declarations.at(0)?.init ?? undefined)
      : undefined;
  const candidate =
    initializer && isBlock && initializer.type === "ArrowFunctionExpression"
      ? initializer.body
      : initializer;
  return (
    candidate !== undefined && syntaxShape(node) === syntaxShape(candidate)
  );
};

// The first declaration of `name` anywhere in the source.
const firstDeclarator = (
  context: SourceContext,
  name: string,
): VariableDeclarator | undefined => {
  for (const node of context.nodes) {
    const declarator = variableDeclarator(node, name);
    if (declarator !== undefined) {
      return declarator;
    }
  }
  return undefined;
};

const ownerArrow = (
  context: SourceContext,
  name: string,
): ArrowFunctionExpression | undefined => {
  const declaration = firstDeclarator(context, name);
  return declaration?.init?.type === "ArrowFunctionExpression"
    ? declaration.init
    : undefined;
};

const provesQuotedIdentifier = (context: SourceContext): boolean => {
  const helper = ownerArrow(context, "quoteIdentifier");
  const pattern = firstDeclarator(context, "POSTGRES_IDENTIFIER");
  return (
    helper !== undefined &&
    sameSyntax(
      helper.body,
      `{
    if (!POSTGRES_IDENTIFIER.test(identifier)) {
      panic(\`Invalid internal PostgreSQL identifier: \${identifier}\`);
    }
    return \`"\${identifier}"\`;
  }`,
    ) &&
    pattern?.init !== undefined &&
    pattern.init !== null &&
    sameSyntax(pattern.init, "/^[A-Za-z_][A-Za-z0-9_]*$/u")
  );
};

const provesSpliced = (context: SourceContext): boolean => {
  const helper = ownerArrow(context, "spliced");
  const tag = firstDeclarator(context, "BLOCK_TAG");
  return (
    helper !== undefined &&
    sameSyntax(
      helper.body,
      `{
    if (text.includes(";") || text.includes(BLOCK_TAG)) {
      panic(\`Online DDL text must be a single statement or expression: \${text}\`);
    }
    return text;
  }`,
    ) &&
    tag?.init !== undefined &&
    tag.init !== null &&
    sameSyntax(tag.init, '"$online_ddl$"')
  );
};

// The parameter an uppercased receiver reads, and the property a
// `parameter.property` receiver reads from it.
const uppercaseReceiver = (
  receiver: Node,
  context: SourceContext,
): { parameterName?: string; receiverProperty?: string } => {
  if (receiver.type === "Identifier") {
    return { parameterName: receiver.name };
  }
  if (
    receiver.type === "MemberExpression" &&
    !receiver.computed &&
    receiver.object.type === "Identifier"
  ) {
    return {
      parameterName: receiver.object.name,
      receiverProperty:
        receiver.property.type === "Identifier"
          ? receiver.property.name
          : nodeText(receiver.property, context.source),
    };
  }
  return {};
};

// The declared type of `property` in the local type alias `type` names.
const aliasedPropertyType = (
  type: TSType,
  property: string,
  context: SourceContext,
): TSType | undefined => {
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
    return type;
  }
  const name = type.typeName.name;
  const alias = context.nodes.find(
    (entry) =>
      entry.type === "TSTypeAliasDeclaration" && entry.id.name === name,
  );
  const member =
    alias?.type === "TSTypeAliasDeclaration" &&
    alias.typeAnnotation.type === "TSTypeLiteral"
      ? alias.typeAnnotation.members.find(
          (entry) =>
            entry.type === "TSPropertySignature" &&
            !entry.computed &&
            nodeText(entry.key, context.source) === property,
        )
      : undefined;
  return member?.type === "TSPropertySignature"
    ? member.typeAnnotation?.typeAnnotation
    : undefined;
};

const finiteUppercaseValues = (
  node: Node,
  context: SourceContext,
): ExpandedSqlVariant[] | undefined => {
  if (
    node.type !== "CallExpression" ||
    node.arguments.length !== 0 ||
    node.callee.type !== "MemberExpression" ||
    node.callee.computed ||
    node.callee.property.type !== "Identifier" ||
    node.callee.property.name !== "toUpperCase"
  ) {
    return undefined;
  }
  const { parameterName, receiverProperty } = uppercaseReceiver(
    node.callee.object,
    context,
  );
  const arrow = nearestArrow(node, context);
  if (!parameterName || arrow === undefined) {
    return undefined;
  }
  const parameter = arrow.params
    .map(parameterIdentifier)
    .find((name) => name?.name === parameterName);
  let type = parameter?.typeAnnotation?.typeAnnotation;
  if (type && receiverProperty !== undefined) {
    type = aliasedPropertyType(type, receiverProperty, context);
  }
  if (!type || type.type !== "TSUnionType") {
    return undefined;
  }
  const values: ExpandedSqlVariant[] = [];
  for (const member of type.types) {
    if (
      member.type !== "TSLiteralType" ||
      member.literal.type !== "Literal" ||
      typeof member.literal.value !== "string"
    ) {
      return undefined;
    }
    values.push({ text: member.literal.value.toUpperCase(), resolved: true });
  }
  return values;
};

// Policy DDL already uses ACCESS EXCLUSIVE. Its expression placeholders must
// never turn into an exception for unresolved ALTER TABLE actions elsewhere.
const isPolicyExpressionSplice = (
  node: CallExpression,
  context: SourceContext,
): boolean => {
  const helper = ownerArrow(context, "policyExpressions");
  if (
    helper === undefined ||
    !sameSyntax(
      helper.body,
      `[
    using === undefined ? "" : \` USING (\${spliced(using)})\`,
    withCheck === undefined ? "" : \` WITH CHECK (\${spliced(withCheck)})\`,
  ].join("")`,
    )
  ) {
    return false;
  }
  return nearestArrow(node, context) === helper;
};

const expandTemplateInterpolation = (
  node: Node,
  context: SourceContext,
  visiting: ReadonlySet<string>,
): ExpandedSqlVariant[] => {
  const expression =
    node.type === "ParenthesizedExpression" ? node.expression : node;
  for (const allowance of TEMPLATE_INTERPOLATION_ALLOWLIST) {
    const variants = allowance.expand(expression);
    if (variants) {
      return variants;
    }
  }
  const finite = finiteUppercaseValues(expression, context);
  if (finite) {
    return finite;
  }
  if (
    expression.type === "CallExpression" &&
    expression.callee.type === "Identifier"
  ) {
    const name = expression.callee.name;
    if (
      name === "spliced" &&
      expression.arguments.length === 1 &&
      provesSpliced(context) &&
      isPolicyExpressionSplice(expression, context)
    ) {
      return [{ text: "TRUE", resolved: true }];
    }
    const literal = ownerArrow(context, "quoteLiteral");
    if (
      name === "quoteLiteral" &&
      expression.arguments.length === 1 &&
      literal &&
      sameSyntax(literal.body, `\`'\${value.replaceAll("'", "''")}'\``)
    ) {
      return [{ text: "'online_ddl_literal'", resolved: true }];
    }
    if (
      [
        "policyTarget",
        "policyExpressions",
        "createPolicyText",
        "dropPolicyText",
      ].includes(name) &&
      !visiting.has(name)
    ) {
      const helper = ownerArrow(context, name);
      if (helper && helper.body.type !== "BlockStatement") {
        return expand(helper.body, context, new Set([...visiting, name]));
      }
    }
  }
  return [{ text: IDENTIFIER_PLACEHOLDER, resolved: false }];
};

const UNRESOLVED: readonly ExpandedSqlVariant[] = [
  { text: IDENTIFIER_PLACEHOLDER, resolved: false },
];

const expand = (
  node: Node,
  context: SourceContext,
  visiting: ReadonlySet<string> = new Set(),
): ExpandedSqlVariant[] => {
  if (node.type === "ParenthesizedExpression") {
    return expand(node.expression, context, visiting);
  }
  const literal = stringLiteralText(node);
  if (literal !== undefined) {
    return [{ text: literal, resolved: true }];
  }
  if (node.type === "ConditionalExpression") {
    return [
      ...expand(node.consequent, context, visiting),
      ...expand(node.alternate, context, visiting),
    ];
  }
  if (node.type === "TemplateLiteral") {
    let variants = [
      { text: node.quasis.at(0)?.value.cooked ?? "", resolved: true },
    ];
    for (const [index, span] of node.expressions.entries()) {
      const values = expandTemplateInterpolation(span, context, visiting);
      const tail = node.quasis.at(index + 1)?.value.cooked ?? "";
      variants = variants.flatMap((prefix) =>
        values.map(({ text, resolved }) => ({
          text: `${prefix.text}${text}${tail}`,
          resolved: prefix.resolved && resolved,
        })),
      );
    }
    return variants;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return expand(node.left, context, visiting).flatMap((left) =>
      expand(node.right, context, visiting).map((right) => ({
        text: `${left.text}${right.text}`,
        resolved: left.resolved && right.resolved,
      })),
    );
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "join" &&
    node.callee.object.type === "ArrayExpression"
  ) {
    const separator = stringLiteralText(node.arguments.at(0) ?? null);
    if (node.arguments.length === 1 && separator !== undefined) {
      let variants = [{ text: "", resolved: true }];
      for (const [index, element] of node.callee.object.elements.entries()) {
        // A hole resolves to nothing, like any other unknown element.
        const values =
          element === null ? UNRESOLVED : expand(element, context, visiting);
        variants = variants.flatMap((prefix) =>
          values.map((value) => ({
            text: `${prefix.text}${index === 0 ? "" : separator}${value.text}`,
            resolved: prefix.resolved && value.resolved,
          })),
        );
      }
      return variants;
    }
  }
  return expandTemplateInterpolation(node, context, visiting);
};

const isWithinLockTaking = (
  node: Node,
  context: SourceContext,
  visiting: ReadonlySet<string> = new Set(),
): boolean => {
  for (const current of ancestry(node, context)) {
    if (isCallTo(current, ["lockTaking", "accessExclusive"])) {
      return current.arguments.some(
        (argument) =>
          argument === node ||
          (argument.start <= node.start && argument.end >= node.end),
      );
    }
  }
  const owner = enclosingVariableName(node, context);
  if (
    !owner ||
    visiting.has(owner) ||
    ![
      "createPolicyText",
      "dropPolicyText",
      "policyTarget",
      "policyExpressions",
    ].includes(owner)
  ) {
    return false;
  }
  const helper = ownerArrow(context, owner);
  const declaration = helper && context.parents.get(helper);
  const statement = declaration && context.parents.get(declaration);
  const statementParent = statement && context.parents.get(statement);
  // A non-exported variable statement (not a `for` head).
  if (
    !helper ||
    !declaration ||
    statement?.type !== "VariableDeclaration" ||
    statementParent?.type === "ExportNamedDeclaration" ||
    statementParent?.type === "ForStatement" ||
    statementParent?.type === "ForInStatement" ||
    statementParent?.type === "ForOfStatement"
  ) {
    return false;
  }
  const references = context.nodes.filter((entry) => {
    if (entry.type !== "Identifier" || entry.name !== owner) {
      return false;
    }
    const parent = context.parents.get(entry);
    return !(parent?.type === "VariableDeclarator" && parent.id === entry);
  });
  return (
    references.length > 0 &&
    references.every((reference) => {
      const parent = context.parents.get(reference);
      return (
        parent?.type === "CallExpression" &&
        parent.callee === reference &&
        isWithinLockTaking(parent, context, new Set([...visiting, owner]))
      );
    })
  );
};

const isCreateSqlIdentifier = (node: Node): boolean =>
  node.type === "Identifier" && node.name === "createSql";

const isSplicedCreateSql = (node: Node): boolean => {
  const argument = isCallTo(node, ["spliced"])
    ? node.arguments.at(0)
    : undefined;
  return (
    isCallTo(node, ["spliced"]) &&
    node.arguments.length === 1 &&
    argument !== undefined &&
    isCreateSqlIdentifier(argument)
  );
};

const enclosingVariableName = (
  node: Node,
  context: SourceContext,
): string | undefined => {
  for (const current of ancestry(node, context)) {
    if (
      current.type === "VariableDeclarator" &&
      current.id.type === "Identifier" &&
      current.init?.type === "ArrowFunctionExpression"
    ) {
      return current.id.name;
    }
  }
  return undefined;
};

const isRuntimeAttemptCallback = (
  call: CallExpression,
  context: SourceContext,
): boolean => {
  for (const current of ancestry(call, context)) {
    if (
      current.type === "ArrowFunctionExpression" &&
      current.params.some(
        (parameter) =>
          parameterIdentifier(parameter)?.name === "guardedConnection",
      )
    ) {
      const parent = context.parents.get(current);
      return (
        parent?.type === "CallExpression" &&
        parent.callee.type === "MemberExpression" &&
        !parent.callee.computed &&
        parent.callee.property.type === "Identifier" &&
        parent.callee.property.name === "attempt" &&
        parent.callee.object.type === "Identifier" &&
        parent.callee.object.name === "runtime" &&
        parent.arguments.at(0) === current
      );
    }
  }
  return false;
};

const constantDeclarations = (
  statements: readonly Node[],
): VariableDeclarator[] =>
  statements.flatMap((statement) => {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    return declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const"
      ? declaration.declarations
      : [];
  });

// Whether `node` ends before a token that precedes `later`. TypeScript
// compared `node.end` with `later`'s full start (the end of the token before
// it), so only trivia between the two does not count.
const endsBeforeTokenOf = (
  node: Node,
  later: Node,
  source: ParsedSource,
): boolean => {
  if (node.end > later.start) {
    return false;
  }
  let cursor = node.end;
  let between = "";
  for (const comment of source.comments) {
    if (comment.start >= node.end && comment.end <= later.start) {
      between += source.sourceText.slice(cursor, comment.start);
      cursor = comment.end;
    }
  }
  between += source.sourceText.slice(cursor, later.start);
  return between.trim() !== "";
};

const provesConcurrentCreateSql = (
  context: SourceContext,
  call: CallExpression,
): boolean => {
  const { source } = context;
  const sourceNodes = constantDeclarations(source.program.body);
  const anchoredPattern = sourceNodes.some(
    (node) =>
      node.id.type === "Identifier" &&
      node.id.name === "createSqlTarget" &&
      node.init?.type === "Literal" &&
      "regex" in node.init &&
      sameSyntax(
        node.init,
        '/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY "?([A-Za-z_][A-Za-z0-9_]*)"? ON public\\."?([A-Za-z_][A-Za-z0-9_]*)"? /u',
      ),
  );
  let owner: VariableDeclarator | undefined;
  for (const current of ancestry(call, context)) {
    if (
      current.type === "VariableDeclarator" &&
      current.id.type === "Identifier" &&
      current.id.name === "createIndexConcurrently"
    ) {
      owner = current;
      break;
    }
  }
  if (owner?.init?.type !== "ArrowFunctionExpression") {
    return false;
  }
  const body = owner.init.body;
  if (body.type !== "BlockStatement") {
    return false;
  }
  const declarations = constantDeclarations(body.body);
  const guardedTarget = body.body.some((node) => {
    if (
      node.type !== "IfStatement" ||
      !sameSyntax(
        node.test,
        "builtName !== name || builtTable !== tableName",
      ) ||
      node.consequent.type !== "BlockStatement" ||
      node.consequent.body.length !== 1
    ) {
      return false;
    }
    const statement = node.consequent.body.at(0);
    return (
      statement?.type === "ExpressionStatement" &&
      isCallTo(statement.expression, ["panic"]) &&
      endsBeforeTokenOf(node, call, source)
    );
  });
  const bindings = [
    ["match", "createSqlTarget.exec(createSql)"],
    ["builtName", "match?.at(1)"],
    ["builtTable", "match?.at(2)"],
  ];
  const boundTargets = bindings.every(
    ([name, expression]) =>
      expression !== undefined &&
      declarations.some(
        (node) =>
          node.id.type === "Identifier" &&
          node.id.name === name &&
          node.init !== null &&
          sameSyntax(node.init, expression) &&
          endsBeforeTokenOf(node, call, source),
      ),
  );

  return anchoredPattern && guardedTarget && boundTargets;
};

const provesDeclaredFunction = (context: SourceContext): boolean => {
  const helper = ownerArrow(context, "callDeclaredFunction");
  return (
    helper !== undefined &&
    sameSyntax(
      helper.body,
      `{
  const declaration = readDdlFunctionDeclaration(name);
  if (!declaration.online) {
    return panic(
      \`Function \${String(name)} is not callable from the online phase\`,
    );
  }
  const { locks } = declaration;
  switch (locks.type) {
    case "table":
      if (locks.tableName !== tableName) {
        return panic(
          \`Function \${String(name)} locks \${locks.tableName}, not \${tableName}\`,
        );
      }
      return accessExclusive(tableName, [
        \`PERFORM "public".\${quoteIdentifier(name)}()\`,
      ]);
    case "table-argument":
      quoteIdentifier(tableName);
      return accessExclusive(tableName, [
        \`PERFORM "public".\${quoteIdentifier(name)}(\${quoteLiteral(tableName)})\`,
      ]);
    default:
      locks satisfies never;
      return panic(\`Function \${String(name)}: unexpected lock declaration\`);
  }
}`,
    )
  );
};

const validateStatementBrand = (context: SourceContext): string[] => {
  const { source } = context;
  const errors: string[] = [];
  const constructor = ownerArrow(context, "lockTaking");
  const lockTakingConstructor =
    constructor !== undefined &&
    sameSyntax(
      constructor.body,
      "({[LOCK_TAKING]: text, tableName, lockQueue})",
    );
  if (!lockTakingConstructor) {
    errors.push(
      "lockTaking constructor is missing or does not construct the private brand",
    );
  }

  const insideConstructor = (node: Node): boolean => {
    for (const current of ancestry(node, context)) {
      if (variableDeclarator(current, "lockTaking") !== undefined) {
        return true;
      }
    }
    return false;
  };

  // The brand's declaration, its type key, the constructor's key, or the
  // one read in sessionOn.
  const isBrandUse = (node: Node): boolean => {
    const parent = context.parents.get(node);
    const grandparent = parent && context.parents.get(parent);
    const declaration =
      parent?.type === "VariableDeclarator" && parent.id === node;
    const typeKey =
      parent?.type === "TSPropertySignature" &&
      parent.computed &&
      parent.key === node;
    const objectKey =
      parent !== undefined &&
      isObjectLiteralProperty(parent, grandparent) &&
      isPropertyAssignment(parent) &&
      parent.computed &&
      parent.key === node &&
      nodeText(parent, source).includes("[LOCK_TAKING]: text") &&
      insideConstructor(parent);
    const sessionRead =
      parent?.type === "MemberExpression" &&
      parent.computed &&
      parent.property === node &&
      nodeText(parent, source) === "statement[LOCK_TAKING]" &&
      enclosingVariableName(parent, context) === "sessionOn";
    return declaration || typeKey || objectKey || sessionRead;
  };

  for (const node of context.nodes) {
    if (
      node.type === "Identifier" &&
      node.name === "LOCK_TAKING" &&
      !isBrandUse(node)
    ) {
      errors.push(
        `LOCK_TAKING may only define the brand and be read by sessionOn (line ${source.locate(node.start).line})`,
      );
    }
    if (
      (node.type === "TSAsExpression" ||
        node.type === "TSTypeAssertion" ||
        node.type === "TSSatisfiesExpression") &&
      nodeText(node.typeAnnotation, source) === "LockTakingStatement"
    ) {
      errors.push(
        `LockTakingStatement must be constructed by lockTaking (line ${source.locate(node.start).line})`,
      );
    }
  }

  return errors;
};

type CheckSqlOptions = {
  text: string;
  node: Node;
  description: string;
  lockQueue?: string;
};
type SqlCensusContext = {
  context: SourceContext;
  checked: Set<Node>;
  errors: string[];
};
const checkSql = ({
  text,
  node,
  description,
  lockQueue,
  context,
  checked,
  errors,
}: CheckSqlOptions & SqlCensusContext): void => {
  const { source } = context;
  const variants = text.split("\n-- variant --\n");
  for (const variant of variants) {
    const line = source.locate(node.start).line;
    const statements = parseMigrationStatements(variant);
    if (statements.length === 0) {
      errors.push(`${description} at line ${line} has an empty SQL variant`);
      continue;
    }
    let classifiedForms = 0;
    for (const statement of statements) {
      if (!isSql(statement.raw)) {
        errors.push(
          `${description} at line ${line} has an unclassified SQL statement: ${statement.raw.trim().slice(0, 140)}`,
        );
        continue;
      }
      const result = censusSql(statement.raw);
      for (const error of result.errors) {
        errors.push(`${description} at line ${line}: ${error}`);
      }
      if (result.forms.length === 0 && result.errors.length === 0) {
        errors.push(
          `${description} at line ${line} has no classified DDL form`,
        );
      }
      classifiedForms += result.forms.length;
      for (const form of result.forms) {
        if (!Object.hasOwn(DDL_FORMS, form.form)) {
          errors.push(
            `${description} at line ${line} classified an unknown DDL form: ${form.form}`,
          );
        }
        if (
          lockQueue === "beside_writers" &&
          isWriterBlockingLock(form.lockMode)
        ) {
          errors.push(
            `${description} at line ${line} must use blocks_writers for ${form.lockMode} ${form.form}`,
          );
        }
        if (
          isWriterBlockingLock(form.lockMode) &&
          !isWithinLockTaking(node, context)
        ) {
          errors.push(
            `${form.lockMode} ${form.form} SQL at line ${line} must be passed through lockTaking`,
          );
        }
      }
    }
    if (classifiedForms === 0) {
      errors.push(
        `${description} at line ${line} has no classified lock-taking statement`,
      );
    }
  }
  checked.add(node);
};

type CheckLockCallOptions = SqlCensusContext & {
  call: CallExpression;
  provedBlock: boolean;
};
const checkLockCall = ({
  call,
  context,
  checked,
  errors,
  provedBlock,
}: CheckLockCallOptions): void => {
  const { source } = context;

  const line = source.locate(call.start).line;
  const options = call.arguments.at(0);
  if (
    call.arguments.length !== 1 ||
    !options ||
    options.type !== "ObjectExpression" ||
    options.properties.length !== 3 ||
    options.properties.some(
      (property) =>
        !isPropertyAssignment(property) && !isShorthandProperty(property),
    )
  ) {
    errors.push(
      `lockTaking at line ${line} requires the closed { tableName, text, lockQueue } object`,
    );
    return;
  }
  const properties = new Map(
    options.properties.map((property) => [
      propertyKeyText(property, source),
      property,
    ]),
  );
  const text = properties.get("text");
  const queue = properties.get("lockQueue");
  const sqlArg = text && isPropertyAssignment(text) ? text.value : undefined;
  const lockQueue =
    queue &&
    isPropertyAssignment(queue) &&
    queue.value.type === "Literal" &&
    typeof queue.value.value === "string"
      ? queue.value.value
      : undefined;
  if (
    !properties.has("tableName") ||
    !sqlArg ||
    !lockQueue ||
    !["beside_writers", "blocks_writers"].includes(lockQueue)
  ) {
    errors.push(
      `lockTaking at line ${line} requires SQL text and a literal lock queue class`,
    );
    return;
  }
  if (enclosingVariableName(call, context) === "accessExclusive") {
    checked.add(sqlArg);
    if (!provedBlock) {
      errors.push(
        "accessExclusive lacks a checked, spliced blocks_writers block builder",
      );
    }
    return;
  }
  if (isCreateSqlIdentifier(sqlArg) || isSplicedCreateSql(sqlArg)) {
    if (
      !isSplicedCreateSql(sqlArg) ||
      !provesSpliced(context) ||
      lockQueue !== "beside_writers" ||
      !provesConcurrentCreateSql(context, call)
    ) {
      errors.push(
        "createSql pass-through lacks an anchored concurrent-index AST proof",
      );
    }
    return;
  }
  for (const variant of expand(sqlArg, context)) {
    if (!variant.resolved) {
      errors.push(
        `lockTaking SQL argument at line ${line} has an unresolved SQL variant`,
      );
    } else {
      checkSql({
        text: variant.text,
        node: sqlArg,
        description: "lockTaking SQL",
        lockQueue,
        context,
        checked,
        errors,
      });
    }
  }
};

const provesBlockBuilder = (context: SourceContext): boolean => {
  const blockBuilder = ownerArrow(context, "accessExclusive");
  return (
    blockBuilder !== undefined &&
    sameSyntax(
      blockBuilder.body,
      `lockTaking({
    tableName,
    text: \`DO \${BLOCK_TAG} BEGIN \${statements.map((statement) => \`\${spliced(statement)};\`).join(" ")} END \${BLOCK_TAG}\`,
    lockQueue: "blocks_writers",
  })`,
    ) &&
    provesSpliced(context)
  );
};

const validateSessionCalls = (
  context: SourceContext,
  sessionCalls: readonly CallExpression[],
): string[] => {
  const { source } = context;
  const errors: string[] = [];
  for (const call of sessionCalls) {
    const owner = enclosingVariableName(call, context);
    const options = call.arguments.at(0);
    const properties = new Map(
      options?.type === "ObjectExpression"
        ? options.properties.map((property) => [
            propertyKeyText(property, source),
            property,
          ])
        : [],
    );
    const closedOptions =
      call.arguments.length === 1 &&
      options?.type === "ObjectExpression" &&
      options.properties.length === 4 &&
      properties.size === 4 &&
      ["connection", "target", "lockRetry", "onRetry"].every((name) =>
        properties.has(name),
      ) &&
      options.properties.every(
        (property) =>
          isPropertyAssignment(property) || isShorthandProperty(property),
      );
    const property = properties.get("connection");
    let connection: Node | undefined;
    if (
      property &&
      (isPropertyAssignment(property) || isShorthandProperty(property))
    ) {
      connection = property.value;
    }
    const line = source.locate(call.start).line;
    if (owner === "runGatedTableWork") {
      if (
        !closedOptions ||
        connection?.type !== "Identifier" ||
        connection.name !== "guardedConnection" ||
        !isRuntimeAttemptCallback(call, context)
      ) {
        errors.push(
          `sessionOn at line ${line} in runGatedTableWork must use the guarded runtime.attempt connection`,
        );
      }
      continue;
    }
    if (owner === "createUngatedTableGateForTests") {
      if (
        !closedOptions ||
        connection?.type !== "Identifier" ||
        connection.name !== "connection"
      ) {
        errors.push(
          `sessionOn at line ${line} in the test gate must use its supplied connection`,
        );
      }
      continue;
    }
    errors.push(
      `sessionOn at line ${line} is outside runGatedTableWork or createUngatedTableGateForTests`,
    );
  }

  return errors;
};

export const censusOnlineDdlSource = (sourceText: string): string[] => {
  const source = parseSource(OWNER_PATH, sourceText);
  const errors: string[] = [];
  const lockCalls: CallExpression[] = [];
  const sessionCalls: CallExpression[] = [];
  const blockCalls: CallExpression[] = [];
  const nodes: Node[] = [];
  const parents = new Map<Node, Node>();
  const context: SourceContext = { source, nodes, parents };
  const sqlNodes: SqlVariant[] = [];

  walk(source.program, (node, ancestors) => {
    nodes.push(node);
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
    if (isCallTo(node, ["accessExclusive"])) {
      blockCalls.push(node);
    }
    if (isCallTo(node, ["lockTaking"])) {
      lockCalls.push(node);
    }
    if (isCallTo(node, ["sessionOn"])) {
      sessionCalls.push(node);
    }
    const text =
      node.type === "TemplateLiteral"
        ? (node.quasis.at(0)?.value.cooked ?? "")
        : stringLiteralText(node);
    if (text !== undefined && isSql(text)) {
      sqlNodes.push({ node });
    }
  });

  if (!provesQuotedIdentifier(context)) {
    errors.push(
      "quoteIdentifier lacks its anchored identifier validation and quoting proof",
    );
  }

  const checked = new Set<Node>();

  const provedBlock = provesBlockBuilder(context);

  for (const call of lockCalls) {
    checkLockCall({ call, context, checked, errors, provedBlock });
  }

  for (const call of blockCalls) {
    const statements = call.arguments.at(1);
    const line = source.locate(call.start).line;
    if (
      !provedBlock ||
      call.arguments.length !== 2 ||
      statements?.type !== "ArrayExpression"
    ) {
      errors.push(
        `accessExclusive at line ${line} requires the checked block builder and a literal statement array`,
      );
      continue;
    }
    for (const statement of statements.elements) {
      if (
        enclosingVariableName(call, context) === "callDeclaredFunction" &&
        provesDeclaredFunction(context)
      ) {
        if (statement !== null) {
          checked.add(statement);
        }
        continue;
      }
      if (statement === null) {
        // A hole expands to one unresolved variant.
        errors.push(
          `accessExclusive SQL argument at line ${line} has an unresolved SQL variant`,
        );
        continue;
      }
      for (const variant of expand(statement, context)) {
        if (!variant.resolved) {
          errors.push(
            `accessExclusive SQL argument at line ${line} has an unresolved SQL variant`,
          );
        } else {
          checkSql({
            text: variant.text,
            node: statement,
            description: "accessExclusive SQL",
            lockQueue: "blocks_writers",
            context,
            checked,
            errors,
          });
        }
      }
    }
  }

  for (const { node } of sqlNodes) {
    if (checked.has(node)) {
      continue;
    }
    for (const variant of expand(node, context)) {
      if (!variant.resolved) {
        errors.push(
          `SQL literal at line ${source.locate(node.start).line} has an unresolved SQL variant`,
        );
      } else {
        checkSql({
          text: variant.text,
          node,
          description: "SQL literal",
          context,
          checked,
          errors,
        });
      }
    }
  }

  errors.push(...validateSessionCalls(context, sessionCalls));

  errors.push(...validateStatementBrand(context));

  return [...new Set(errors)];
};

export const checkOnlineDdlLockCensus = (): string[] =>
  censusOnlineDdlSource(
    readFileSync(path.resolve(REPOSITORY_ROOT, OWNER_PATH), "utf-8"),
  );

if (import.meta.main) {
  const errors = checkOnlineDdlLockCensus();
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
