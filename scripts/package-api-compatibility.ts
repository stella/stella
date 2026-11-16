import { panic } from "better-result";
import ts from "typescript6";

type Method = ts.MethodSignature | ts.MethodDeclaration;

const methodKey = (method: Method, source: ts.SourceFile): string =>
  `${method.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.StaticKeyword) === true ? "static:" : "instance:"}${ts.isComputedPropertyName(method.name) ? method.name.getText(source) : method.name.text}`;

const structuralClassMember = (member: ts.ClassElement): ts.ClassElement[] => {
  if (ts.isConstructorDeclaration(member)) {
    return [member];
  }
  const modifiers = ts.canHaveModifiers(member)
    ? ts.getModifiers(member)
    : undefined;
  if (
    modifiers?.some(({ kind }) => kind === ts.SyntaxKind.PrivateKeyword) ===
      true ||
    (member.name !== undefined && ts.isPrivateIdentifier(member.name))
  ) {
    return [];
  }
  if (
    modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ProtectedKeyword) !==
      true ||
    member.name === undefined
  ) {
    return [member];
  }
  // Virtual declaration trees have distinct nominal identities. Preserve
  // protected API members structurally, separately from public members.
  const name = ts.factory.createStringLiteral(
    `__api_protected_${member.name.getText()}`,
  );
  if (ts.isPropertyDeclaration(member)) {
    return [
      ts.factory.updatePropertyDeclaration(
        member,
        member.modifiers?.filter(
          ({ kind }) => kind !== ts.SyntaxKind.ProtectedKeyword,
        ),
        name,
        member.questionToken ?? member.exclamationToken,
        member.type,
        member.initializer,
      ),
    ];
  }
  if (ts.isMethodDeclaration(member)) {
    return [
      ts.factory.updateMethodDeclaration(
        member,
        member.modifiers?.filter(
          ({ kind }) => kind !== ts.SyntaxKind.ProtectedKeyword,
        ),
        member.asteriskToken,
        name,
        member.questionToken,
        member.typeParameters,
        member.parameters,
        member.type,
        member.body,
      ),
    ];
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return [
      ts.factory.updateGetAccessorDeclaration(
        member,
        member.modifiers?.filter(
          ({ kind }) => kind !== ts.SyntaxKind.ProtectedKeyword,
        ),
        name,
        member.parameters,
        member.type,
        member.body,
      ),
    ];
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return [
      ts.factory.updateSetAccessorDeclaration(
        member,
        member.modifiers?.filter(
          ({ kind }) => kind !== ts.SyntaxKind.ProtectedKeyword,
        ),
        name,
        member.parameters,
        member.body,
      ),
    ];
  }
  return [member];
};

const strictMethodType = (methods: readonly Method[]): ts.TypeNode => {
  const first = methods.at(0) ?? panic("An API method group cannot be empty");
  if (methods.length === 1) {
    return ts.factory.createFunctionTypeNode(
      first.typeParameters,
      first.parameters,
      first.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
    );
  }
  // A nested object with call signatures changes the lexical owner of `this`.
  // Function intersections retain the overload order and strict parameters
  // while keeping polymorphic receivers bound to their class or interface.
  return ts.factory.createIntersectionTypeNode(
    methods.map((method) =>
      ts.factory.createFunctionTypeNode(
        method.typeParameters,
        method.parameters,
        method.type ??
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ),
    ),
  );
};

const isUniqueSymbolType = (type: ts.TypeNode | undefined): boolean =>
  type !== undefined &&
  ts.isTypeOperatorNode(type) &&
  type.operator === ts.SyntaxKind.UniqueKeyword &&
  type.type.kind === ts.SyntaxKind.SymbolKeyword;

/**
 * Each declaration tree declares its own `unique symbol`, so a brand keyed on
 * one is nominally different in the base and the current tree although
 * nothing changed. The symbol becomes a string literal named after its file
 * and declaration, the same on both sides and distinct from every other.
 */
const uniqueSymbolStandIn = (file: string, name: ts.Node): ts.TypeNode =>
  ts.factory.createLiteralTypeNode(
    ts.factory.createStringLiteral(
      `__api_unique_symbol:${file}:${ts.isIdentifier(name) ? name.text : name.getText()}`,
    ),
  );

// TypeScript deliberately compares method parameters bivariantly. API
// compatibility must reject narrower inputs, including overloaded methods.
export const normalizeCompatibilityDeclarations = (
  contents: string,
  /** The declaration's path in the report, the same in both trees. */
  file = "api.d.ts",
): string => {
  const source = ts.createSourceFile(
    "api.d.ts",
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const transformed = ts.transform(source, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        let visited = ts.visitEachChild(node, visit, context);
        if (
          ts.isVariableDeclaration(visited) &&
          isUniqueSymbolType(visited.type)
        ) {
          return ts.factory.updateVariableDeclaration(
            visited,
            visited.name,
            visited.exclamationToken,
            uniqueSymbolStandIn(file, visited.name),
            visited.initializer,
          );
        }
        if (
          ts.isPropertyDeclaration(visited) &&
          isUniqueSymbolType(visited.type)
        ) {
          visited = ts.factory.updatePropertyDeclaration(
            visited,
            visited.modifiers,
            visited.name,
            visited.questionToken ?? visited.exclamationToken,
            uniqueSymbolStandIn(file, visited.name),
            visited.initializer,
          );
        }
        if (
          ts.isPropertySignature(visited) &&
          isUniqueSymbolType(visited.type)
        ) {
          return ts.factory.updatePropertySignature(
            visited,
            visited.modifiers,
            visited.name,
            visited.questionToken,
            uniqueSymbolStandIn(file, visited.name),
          );
        }
        if (ts.isClassDeclaration(visited)) {
          visited = ts.factory.updateClassDeclaration(
            visited,
            visited.modifiers,
            visited.name,
            visited.typeParameters,
            visited.heritageClauses,
            visited.members.flatMap(structuralClassMember),
          );
        }
        if (
          ts.isInterfaceDeclaration(visited) ||
          ts.isClassDeclaration(visited) ||
          ts.isTypeLiteralNode(visited)
        ) {
          const groups = new Map<string, Method[]>();
          for (const member of visited.members) {
            if (
              !ts.isMethodSignature(member) &&
              !ts.isMethodDeclaration(member)
            ) {
              continue;
            }
            const key = methodKey(member, source);
            const group = groups.get(key);
            if (group === undefined) {
              groups.set(key, [member]);
            } else {
              group.push(member);
            }
          }
          if (
            ts.isInterfaceDeclaration(visited) ||
            ts.isTypeLiteralNode(visited)
          ) {
            const members: ts.TypeElement[] = [];
            for (const member of visited.members) {
              if (!ts.isMethodSignature(member)) {
                members.push(member);
                continue;
              }
              const key = methodKey(member, source);
              const methods = groups.get(key);
              if (methods === undefined) {
                continue;
              }
              groups.delete(key);
              members.push(
                ts.factory.createPropertySignature(
                  member.modifiers,
                  member.name,
                  member.questionToken,
                  strictMethodType(methods),
                ),
              );
            }
            if (ts.isTypeLiteralNode(visited)) {
              return ts.factory.updateTypeLiteralNode(
                visited,
                ts.factory.createNodeArray(members),
              );
            }
            return ts.factory.updateInterfaceDeclaration(
              visited,
              visited.modifiers,
              visited.name,
              visited.typeParameters,
              visited.heritageClauses,
              members,
            );
          }
          const members: ts.ClassElement[] = [];
          for (const member of visited.members) {
            if (!ts.isMethodDeclaration(member)) {
              members.push(member);
              continue;
            }
            const key = methodKey(member, source);
            const methods = groups.get(key);
            if (methods === undefined) {
              continue;
            }
            groups.delete(key);
            members.push(
              ts.factory.createPropertyDeclaration(
                member.modifiers,
                member.name,
                member.questionToken,
                strictMethodType(methods),
                undefined,
              ),
            );
          }
          return ts.factory.updateClassDeclaration(
            visited,
            visited.modifiers,
            visited.name,
            visited.typeParameters,
            visited.heritageClauses,
            members,
          );
        }
        return visited;
      };
      return (node) =>
        ts.visitNode(node, visit, ts.isSourceFile) ??
        panic("API declaration transformation lost its source");
    },
  ]);
  const result =
    transformed.transformed.at(0) ??
    panic("API declaration transformation produced no source");
  const printed = ts.createPrinter({ removeComments: true }).printFile(result);
  transformed.dispose();
  return printed;
};

const GENERIC_TYPE_PROBE = "__api_generic_probe_";

/** A name the comparison declares for itself, never part of the public API. */
export const isGenericTypeProbeName = (name: string): boolean =>
  name.startsWith(GENERIC_TYPE_PROBE);

type GenericTypeDeclaration = (
  ts.InterfaceDeclaration | ts.ClassDeclaration | ts.TypeAliasDeclaration
) & {
  name: ts.Identifier;
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration>;
};

export const isGenericTypeDeclaration = (
  node: ts.Node,
): node is GenericTypeDeclaration =>
  (ts.isInterfaceDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)) &&
  node.name !== undefined &&
  (node.typeParameters?.length ?? 0) > 0;

export const omittedTypeArgumentCounts = (
  declaration: GenericTypeDeclaration,
): number[] => {
  const counts: number[] = [];
  for (
    let provided = declaration.typeParameters.length - 1;
    provided >= 0;
    provided -= 1
  ) {
    if (declaration.typeParameters[provided]?.default === undefined) {
      break;
    }
    counts.push(provided);
  }
  return counts;
};

/**
 * The probe declared beside a generic type, found among the statements of
 * the block that declares it: the probe's result names the type.
 */
export const genericTypeProbe = (
  declaration: GenericTypeDeclaration,
  {
    space = "type",
    provided = declaration.typeParameters.length,
  }: {
    space?: "type" | "value";
    provided?: number;
  } = {},
): ts.FunctionTypeNode | undefined => {
  const block = declaration.parent;
  if (!ts.isSourceFile(block) && !ts.isModuleBlock(block)) {
    return undefined;
  }
  for (const statement of block.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      isGenericTypeProbeName(statement.name.text) &&
      ts.isFunctionTypeNode(statement.type)
    ) {
      const result = statement.type.type;
      let reference: ts.TypeReferenceNode | ts.TypeQueryNode | undefined;
      if (space === "type" && ts.isTypeReferenceNode(result)) {
        reference = result;
      } else if (space === "value" && ts.isTypeQueryNode(result)) {
        reference = result;
      }
      if (
        reference === undefined ||
        (reference.typeArguments?.length ?? 0) !== provided
      ) {
        continue;
      }
      const name = ts.isTypeReferenceNode(reference)
        ? reference.typeName
        : reference.exprName;
      if (ts.isIdentifier(name) && name.text === declaration.name.text) {
        return statement.type;
      }
    }
  }
  return undefined;
};

/**
 * Each declaration tree has its own type parameters, so a generic type is
 * never assignable to its unchanged self: `T` before is not `T` after. Beside
 * every generic type this declares, in the same scope, a generic function
 * `<T extends C = D, ...>(p0: T, ...) => Name<T, ...>`. TypeScript relates two
 * generic signatures by unifying their type parameters position by position
 * through the parameters, so comparing the before and after probes compares
 * the two declarations with shared type parameters: an unchanged shape
 * passes, while a changed member, constraint or parameter count does not.
 * Classes also get a `typeof Name<T, ...>` result for their full value contract.
 * Additional type probes omit each defaulted suffix, so the compiler resolves
 * the defaults with the same earlier arguments on both sides.
 */
export const withGenericTypeProbes = (
  contents: string,
  /** The declaration's path in the report; keeps probe names unique per file. */
  file = "api.d.ts",
): string => {
  const source = ts.createSourceFile(
    "api.d.ts",
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const tag = file.replaceAll(/[^\p{L}\p{N}_$]/gu, "_");
  const printer = ts.createPrinter({ removeComments: true });
  const probes: { end: number; text: string }[] = [];
  const probe = (
    declaration: GenericTypeDeclaration,
    space: "type" | "value",
    provided = declaration.typeParameters.length,
  ): string => {
    const parameters = declaration.typeParameters.slice(0, provided);
    const arguments_ =
      parameters.length === 0
        ? undefined
        : parameters.map((parameter) =>
            ts.factory.createTypeReferenceNode(parameter.name),
          );
    const result =
      space === "type"
        ? ts.factory.createTypeReferenceNode(declaration.name, arguments_)
        : ts.factory.createTypeQueryNode(declaration.name, arguments_);
    return printer.printNode(
      ts.EmitHint.Unspecified,
      ts.factory.createTypeAliasDeclaration(
        undefined,
        `${GENERIC_TYPE_PROBE}${tag}_${probes.length}_${space}_${provided}`,
        undefined,
        ts.factory.createFunctionTypeNode(
          parameters.length === 0
            ? undefined
            : parameters.map((parameter) =>
                ts.factory.createTypeParameterDeclaration(
                  undefined,
                  parameter.name,
                  parameter.constraint,
                  parameter.default,
                ),
              ),
          parameters.map((parameter, position) =>
            ts.factory.createParameterDeclaration(
              undefined,
              undefined,
              `p${position}`,
              undefined,
              ts.factory.createTypeReferenceNode(parameter.name),
            ),
          ),
          result,
        ),
      ),
      source,
    );
  };
  const visitBlock = (statements: readonly ts.Statement[]): void => {
    // A later merged declaration can add a value space or defaults. Deduplicate
    // only identical probe contracts, after considering every declaration.
    const probed = new Set<string>();
    for (const statement of statements) {
      if (ts.isModuleDeclaration(statement)) {
        visitModule(statement);
      } else if (isGenericTypeDeclaration(statement)) {
        const text: string[] = [];
        const add = (
          space: "type" | "value",
          provided = statement.typeParameters.length,
        ): void => {
          const key = `${statement.name.text}:${space}:${provided}`;
          if (!probed.has(key)) {
            probed.add(key);
            text.push(probe(statement, space, provided));
          }
        };
        add("type");
        if (ts.isClassDeclaration(statement)) {
          add("value");
        }
        // Resolve each valid omitted suffix through the compiler, including
        // defaults depending on earlier, explicitly supplied type arguments.
        for (const provided of omittedTypeArgumentCounts(statement)) {
          add("type", provided);
        }
        if (text.length > 0) {
          probes.push({ end: statement.end, text: text.join("\n") });
        }
      }
    }
  };
  const visitModule = (declaration: ts.ModuleDeclaration): void => {
    const { body } = declaration;
    if (body === undefined) {
      return;
    }
    if (ts.isModuleBlock(body)) {
      visitBlock(body.statements);
    } else if (ts.isModuleDeclaration(body)) {
      // `namespace a.b {}` nests the declaration of `b` as the body of `a`.
      visitModule(body);
    }
  };
  visitBlock(source.statements);
  // Each probe follows its declaration in the same block, so it resolves
  // every name in the type parameter list exactly as the declaration does.
  let probed = contents;
  for (const { end, text } of probes.toReversed()) {
    probed = `${probed.slice(0, end)}\n${text}${probed.slice(end)}`;
  }
  return probed;
};
