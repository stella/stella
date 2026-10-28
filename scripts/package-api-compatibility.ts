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
  return ts.factory.createTypeLiteralNode(
    methods.map((method) =>
      ts.factory.createCallSignature(
        method.typeParameters,
        method.parameters,
        method.type ??
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ),
    ),
  );
};

// TypeScript deliberately compares method parameters bivariantly. API
// compatibility must reject narrower inputs, including overloaded methods.
export const normalizeCompatibilityDeclarations = (
  contents: string,
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
              return ts.factory.updateTypeLiteralNode(visited, members);
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
