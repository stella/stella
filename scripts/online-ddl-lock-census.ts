import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

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

type SqlVariant = { node: ts.Expression };
type ExpandedSqlVariant = { text: string; resolved: boolean };
type SourceContext = {
  source: ts.SourceFile;
  nodes: readonly ts.Node[];
};

type TemplateInterpolationAllowance = {
  shape: string;
  reason: string;
  expand: (node: ts.Expression) => ExpandedSqlVariant[] | undefined;
};

const isSql = (text: string): boolean => SQL_START.test(text);

export const TEMPLATE_INTERPOLATION_ALLOWLIST: TemplateInterpolationAllowance[] =
  [
    {
      shape: "quoteIdentifier(...) call",
      reason:
        "quoteIdentifier returns one validated, double-quoted PostgreSQL identifier.",
      expand: (node) =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "quoteIdentifier" &&
        node.arguments.length === 1
          ? [{ text: IDENTIFIER_PLACEHOLDER, resolved: true }]
          : undefined,
    },
    {
      shape: "conditional with literal-only branches",
      reason:
        "Literal branches are enumerated independently and cannot inject uninspected SQL.",
      expand: (node) =>
        ts.isConditionalExpression(node) &&
        ts.isStringLiteralLike(node.whenTrue) &&
        ts.isStringLiteralLike(node.whenFalse)
          ? [
              { text: node.whenTrue.text, resolved: true },
              { text: node.whenFalse.text, resolved: true },
            ]
          : undefined,
    },
  ];

const syntaxShape = (node: ts.Node): string => {
  const children: string[] = [];
  ts.forEachChild(node, (child) => {
    children.push(syntaxShape(child));
  });
  const text =
    ts.isIdentifier(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
      ? node.text
      : "";
  const operator =
    ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
      ? node.operator
      : undefined;
  return JSON.stringify([node.kind, text, operator, children]);
};

const sameSyntax = (node: ts.Node, expression: string): boolean => {
  const fixture = ts.createSourceFile(
    "proof.ts",
    `const proof = ${ts.isBlock(node) ? `() => ${expression}` : expression};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = fixture.statements.at(0);
  const initializer =
    statement && ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.at(0)?.initializer
      : undefined;
  const candidate =
    initializer && ts.isBlock(node) && ts.isArrowFunction(initializer)
      ? initializer.body
      : initializer;
  return (
    candidate !== undefined && syntaxShape(node) === syntaxShape(candidate)
  );
};

const ownerArrow = (
  context: SourceContext,
  name: string,
): ts.ArrowFunction | undefined => {
  const declaration = context.nodes.find(
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name,
  );
  return declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    ts.isArrowFunction(declaration.initializer)
    ? declaration.initializer
    : undefined;
};

const provesQuotedIdentifier = (context: SourceContext): boolean => {
  const helper = ownerArrow(context, "quoteIdentifier");
  const pattern = context.nodes.find(
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "POSTGRES_IDENTIFIER",
  );
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
    pattern !== undefined &&
    ts.isVariableDeclaration(pattern) &&
    pattern.initializer !== undefined &&
    sameSyntax(pattern.initializer, "/^[A-Za-z_][A-Za-z0-9_]*$/u")
  );
};

const provesSpliced = (context: SourceContext): boolean => {
  const helper = ownerArrow(context, "spliced");
  const tag = context.nodes.find(
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "BLOCK_TAG",
  );
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
    tag !== undefined &&
    ts.isVariableDeclaration(tag) &&
    tag.initializer !== undefined &&
    sameSyntax(tag.initializer, '"$online_ddl$"')
  );
};

const finiteUppercaseValues = (
  node: ts.Expression,
  context: SourceContext,
): ExpandedSqlVariant[] | undefined => {
  if (
    !ts.isCallExpression(node) ||
    node.arguments.length !== 0 ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "toUpperCase"
  ) {
    return undefined;
  }
  const receiver = node.expression.expression;
  let parameterName: string | undefined;
  if (ts.isIdentifier(receiver)) {
    parameterName = receiver.text;
  } else if (
    ts.isPropertyAccessExpression(receiver) &&
    ts.isIdentifier(receiver.expression)
  ) {
    parameterName = receiver.expression.text;
  }
  let current: ts.Node = node;
  while (!ts.isArrowFunction(current) && !ts.isSourceFile(current)) {
    current = current.parent;
  }
  if (!parameterName || !ts.isArrowFunction(current)) {
    return undefined;
  }
  const parameter = current.parameters.find(
    ({ name }) => ts.isIdentifier(name) && name.text === parameterName,
  );
  let type = parameter?.type;
  if (
    type &&
    ts.isPropertyAccessExpression(receiver) &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName)
  ) {
    const name = type.typeName.text;
    const alias = context.nodes.find(
      (entry) => ts.isTypeAliasDeclaration(entry) && entry.name.text === name,
    );
    const property =
      alias &&
      ts.isTypeAliasDeclaration(alias) &&
      ts.isTypeLiteralNode(alias.type)
        ? alias.type.members.find(
            (entry) =>
              ts.isPropertySignature(entry) &&
              entry.name.getText(context.source) === receiver.name.text,
          )
        : undefined;
    type =
      property && ts.isPropertySignature(property) ? property.type : undefined;
  }
  if (!type || !ts.isUnionTypeNode(type)) {
    return undefined;
  }
  const values: ExpandedSqlVariant[] = [];
  for (const member of type.types) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      return undefined;
    }
    values.push({ text: member.literal.text.toUpperCase(), resolved: true });
  }
  return values;
};

// Policy DDL already uses ACCESS EXCLUSIVE. Its expression placeholders must
// never turn into an exception for unresolved ALTER TABLE actions elsewhere.
const isPolicyExpressionSplice = (
  node: ts.CallExpression,
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
  let owner: ts.Node = node;
  while (!ts.isArrowFunction(owner) && !ts.isSourceFile(owner)) {
    owner = owner.parent;
  }
  return owner === helper;
};

const expandTemplateInterpolation = (
  node: ts.Expression,
  context: SourceContext,
  visiting: ReadonlySet<string>,
): ExpandedSqlVariant[] => {
  const expression = ts.isParenthesizedExpression(node)
    ? node.expression
    : node;
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
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const name = expression.expression.text;
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
      if (helper && !ts.isBlock(helper.body)) {
        return expand(helper.body, context, new Set([...visiting, name]));
      }
    }
  }
  return [{ text: IDENTIFIER_PLACEHOLDER, resolved: false }];
};

const expand = (
  node: ts.Expression,
  context: SourceContext,
  visiting: ReadonlySet<string> = new Set(),
): ExpandedSqlVariant[] => {
  if (ts.isParenthesizedExpression(node)) {
    return expand(node.expression, context, visiting);
  }
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return [{ text: node.text, resolved: true }];
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...expand(node.whenTrue, context, visiting),
      ...expand(node.whenFalse, context, visiting),
    ];
  }
  if (ts.isTemplateExpression(node)) {
    let variants = [{ text: node.head.text, resolved: true }];
    for (const span of node.templateSpans) {
      const values = expandTemplateInterpolation(
        span.expression,
        context,
        visiting,
      );
      variants = variants.flatMap((prefix) =>
        values.map(({ text, resolved }) => ({
          text: `${prefix.text}${text}${span.literal.text}`,
          resolved: prefix.resolved && resolved,
        })),
      );
    }
    return variants;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return expand(node.left, context, visiting).flatMap((left) =>
      expand(node.right, context, visiting).map((right) => ({
        text: `${left.text}${right.text}`,
        resolved: left.resolved && right.resolved,
      })),
    );
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    ts.isArrayLiteralExpression(node.expression.expression)
  ) {
    const separator = node.arguments.at(0);
    if (
      node.arguments.length === 1 &&
      separator &&
      ts.isStringLiteralLike(separator)
    ) {
      let variants = [{ text: "", resolved: true }];
      for (const [
        index,
        element,
      ] of node.expression.expression.elements.entries()) {
        variants = variants.flatMap((prefix) =>
          expand(element, context, visiting).map((value) => ({
            text: `${prefix.text}${index === 0 ? "" : separator.text}${value.text}`,
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
  node: ts.Node,
  context: SourceContext,
  visiting: ReadonlySet<string> = new Set(),
): boolean => {
  let current = node;
  while (current.kind !== ts.SyntaxKind.SourceFile) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      ["lockTaking", "accessExclusive"].includes(current.expression.text)
    ) {
      return current.arguments.some(
        (argument) =>
          argument === node ||
          (argument.pos <= node.pos && argument.end >= node.end),
      );
    }
    current = current.parent;
  }
  const owner = enclosingVariableName(node);
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
  const declaration = helper?.parent;
  const statement = declaration?.parent.parent;
  if (
    !helper ||
    !declaration ||
    !statement ||
    !ts.isVariableStatement(statement) ||
    statement.modifiers?.some(
      ({ kind }) => kind === ts.SyntaxKind.ExportKeyword,
    )
  ) {
    return false;
  }
  const references = context.nodes.filter(
    (entry) =>
      ts.isIdentifier(entry) &&
      entry.text === owner &&
      !(ts.isVariableDeclaration(entry.parent) && entry.parent.name === entry),
  );
  return (
    references.length > 0 &&
    references.every(
      (reference) =>
        ts.isCallExpression(reference.parent) &&
        reference.parent.expression === reference &&
        isWithinLockTaking(
          reference.parent,
          context,
          new Set([...visiting, owner]),
        ),
    )
  );
};

const isCreateSqlIdentifier = (node: ts.Expression): boolean =>
  ts.isIdentifier(node) && node.text === "createSql";

const isSplicedCreateSql = (node: ts.Expression): boolean => {
  const argument = ts.isCallExpression(node) ? node.arguments.at(0) : undefined;
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "spliced" &&
    node.arguments.length === 1 &&
    argument !== undefined &&
    isCreateSqlIdentifier(argument)
  );
};

const enclosingVariableName = (node: ts.Node): string | undefined => {
  let current = node;
  while (current.kind !== ts.SyntaxKind.SourceFile) {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer &&
      ts.isArrowFunction(current.initializer)
    ) {
      return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
};

const isRuntimeAttemptCallback = (call: ts.CallExpression): boolean => {
  let current = call.parent;
  while (current.kind !== ts.SyntaxKind.SourceFile) {
    if (
      ts.isArrowFunction(current) &&
      current.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === "guardedConnection",
      )
    ) {
      const parent = current.parent;
      return (
        ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === "attempt" &&
        ts.isIdentifier(parent.expression.expression) &&
        parent.expression.expression.text === "runtime" &&
        parent.arguments.at(0) === current
      );
    }
    current = current.parent;
  }
  return false;
};

const constantDeclarations = (
  statements: readonly ts.Statement[],
  source: ts.SourceFile,
) =>
  statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.getFirstToken(source)?.kind ===
      ts.SyntaxKind.ConstKeyword
      ? [...statement.declarationList.declarations]
      : [],
  );

const provesConcurrentCreateSql = (
  source: ts.SourceFile,
  call: ts.CallExpression,
): boolean => {
  const sourceNodes = constantDeclarations(source.statements, source);
  const anchoredPattern = sourceNodes.some(
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "createSqlTarget" &&
      node.initializer &&
      ts.isRegularExpressionLiteral(node.initializer) &&
      sameSyntax(
        node.initializer,
        '/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY "?([A-Za-z_][A-Za-z0-9_]*)"? ON public\\."?([A-Za-z_][A-Za-z0-9_]*)"? /u',
      ),
  );
  let current = call.parent;
  while (
    current.kind !== ts.SyntaxKind.SourceFile &&
    !(
      ts.isVariableDeclaration(current) &&
      current.name.getText(source) === "createIndexConcurrently"
    )
  ) {
    current = current.parent;
  }
  if (
    !ts.isVariableDeclaration(current) ||
    !current.initializer ||
    !ts.isArrowFunction(current.initializer)
  ) {
    return false;
  }
  const body = current.initializer.body;
  if (!ts.isBlock(body)) {
    return false;
  }
  const declarations = constantDeclarations(body.statements, source);
  const guardedTarget = body.statements.some((node) => {
    if (
      !ts.isIfStatement(node) ||
      !sameSyntax(
        node.expression,
        "builtName !== name || builtTable !== tableName",
      ) ||
      !ts.isBlock(node.thenStatement) ||
      node.thenStatement.statements.length !== 1
    ) {
      return false;
    }
    const statement = node.thenStatement.statements.at(0);
    return (
      statement !== undefined &&
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === "panic" &&
      node.end < call.pos
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
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === name &&
          node.initializer !== undefined &&
          sameSyntax(node.initializer, expression) &&
          node.end < call.pos,
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

const validateStatementBrand = (source: ts.SourceFile): string[] => {
  const errors: string[] = [];
  const nodes: ts.Node[] = [];
  const findConstructor = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, findConstructor);
  };
  findConstructor(source);
  const constructor = ownerArrow({ source, nodes }, "lockTaking");
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

  const insideConstructor = (node: ts.Node): boolean => {
    let current = node;
    while (current.kind !== ts.SyntaxKind.SourceFile) {
      if (
        ts.isVariableDeclaration(current) &&
        ts.isIdentifier(current.name) &&
        current.name.text === "lockTaking"
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };

  const validateBrandUse = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "LOCK_TAKING") {
      const parent = node.parent;
      const declaration =
        ts.isVariableDeclaration(parent) && parent.name === node;
      const typeKey =
        ts.isComputedPropertyName(parent) &&
        ts.isPropertySignature(parent.parent);
      const objectKey =
        ts.isComputedPropertyName(parent) &&
        ts.isPropertyAssignment(parent.parent) &&
        parent.parent.getText(source).includes("[LOCK_TAKING]: text") &&
        insideConstructor(parent);
      const sessionRead =
        ts.isElementAccessExpression(parent) &&
        parent.argumentExpression === node &&
        parent.getText(source) === "statement[LOCK_TAKING]" &&
        enclosingVariableName(parent) === "sessionOn";
      if (!declaration && !typeKey && !objectKey && !sessionRead) {
        errors.push(
          `LOCK_TAKING may only define the brand and be read by sessionOn (line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1})`,
        );
      }
    }
    if (
      (ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node)) &&
      node.type.getText(source) === "LockTakingStatement"
    ) {
      errors.push(
        `LockTakingStatement must be constructed by lockTaking (line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1})`,
      );
    }
    ts.forEachChild(node, validateBrandUse);
  };
  validateBrandUse(source);

  return errors;
};

type CheckSqlOptions = {
  text: string;
  node: ts.Node;
  description: string;
  lockQueue?: string;
};
type SqlCensusContext = {
  context: SourceContext;
  checked: Set<ts.Node>;
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
    const line =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
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
  call: ts.CallExpression;
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

  const line =
    source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
  const options = call.arguments.at(0);
  if (
    call.arguments.length !== 1 ||
    !options ||
    !ts.isObjectLiteralExpression(options) ||
    options.properties.length !== 3 ||
    options.properties.some(
      (property) =>
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property),
    )
  ) {
    errors.push(
      `lockTaking at line ${line} requires the closed { tableName, text, lockQueue } object`,
    );
    return;
  }
  const properties = new Map(
    options.properties.map((property) => [
      "name" in property ? property.name.getText(source) : undefined,
      property,
    ]),
  );
  const text = properties.get("text");
  const queue = properties.get("lockQueue");
  const sqlArg =
    text && ts.isPropertyAssignment(text) ? text.initializer : undefined;
  const lockQueue =
    queue &&
    ts.isPropertyAssignment(queue) &&
    ts.isStringLiteral(queue.initializer)
      ? queue.initializer.text
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
  if (enclosingVariableName(call) === "accessExclusive") {
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
      !provesConcurrentCreateSql(source, call)
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
  sessionCalls: readonly ts.CallExpression[],
): string[] => {
  const { source } = context;
  const errors: string[] = [];
  for (const call of sessionCalls) {
    const owner = enclosingVariableName(call);
    const options = call.arguments.at(0);
    const properties = new Map(
      options && ts.isObjectLiteralExpression(options)
        ? options.properties.map((property) => [
            "name" in property ? property.name.getText(source) : undefined,
            property,
          ])
        : [],
    );
    const closedOptions =
      call.arguments.length === 1 &&
      options !== undefined &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.length === 4 &&
      properties.size === 4 &&
      ["connection", "target", "lockRetry", "onRetry"].every((name) =>
        properties.has(name),
      ) &&
      options.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property),
      );
    const property = properties.get("connection");
    let connection: ts.Expression | undefined;
    if (property && ts.isPropertyAssignment(property)) {
      connection = property.initializer;
    } else if (property && ts.isShorthandPropertyAssignment(property)) {
      connection = property.name;
    }
    const line =
      source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
    if (owner === "runGatedTableWork") {
      if (
        !closedOptions ||
        !connection ||
        !ts.isIdentifier(connection) ||
        connection.text !== "guardedConnection" ||
        !isRuntimeAttemptCallback(call)
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
        !connection ||
        !ts.isIdentifier(connection) ||
        connection.text !== "connection"
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
  const source = ts.createSourceFile(
    OWNER_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const errors: string[] = [];
  const lockCalls: ts.CallExpression[] = [];
  const sessionCalls: ts.CallExpression[] = [];
  const blockCalls: ts.CallExpression[] = [];
  const nodes: ts.Node[] = [];
  const context: SourceContext = { source, nodes };
  const sqlNodes: SqlVariant[] = [];

  const visit = (node: ts.Node): void => {
    nodes.push(node);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "accessExclusive"
    ) {
      blockCalls.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "lockTaking"
    ) {
      lockCalls.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "sessionOn"
    ) {
      sessionCalls.push(node);
    }
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      (ts.isTemplateExpression(node) ? isSql(node.head.text) : isSql(node.text))
    ) {
      sqlNodes.push({ node });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (!provesQuotedIdentifier(context)) {
    errors.push(
      "quoteIdentifier lacks its anchored identifier validation and quoting proof",
    );
  }

  const checked = new Set<ts.Node>();

  const provedBlock = provesBlockBuilder(context);

  for (const call of lockCalls) {
    checkLockCall({ call, context, checked, errors, provedBlock });
  }

  for (const call of blockCalls) {
    const statements = call.arguments.at(1);
    const line =
      source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
    if (
      !provedBlock ||
      call.arguments.length !== 2 ||
      !statements ||
      !ts.isArrayLiteralExpression(statements)
    ) {
      errors.push(
        `accessExclusive at line ${line} requires the checked block builder and a literal statement array`,
      );
      continue;
    }
    for (const statement of statements.elements) {
      if (
        enclosingVariableName(call) === "callDeclaredFunction" &&
        provesDeclaredFunction(context)
      ) {
        checked.add(statement);
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
          `SQL literal at line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} has an unresolved SQL variant`,
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

  errors.push(...validateStatementBrand(source));

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
