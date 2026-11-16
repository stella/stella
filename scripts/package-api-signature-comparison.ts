import { panic } from "better-result";
import ts from "typescript6";

import {
  genericTypeProbe,
  isGenericTypeDeclaration,
  withGenericTypeProbes,
} from "./package-api-compatibility";

const enclosingScope = (node: ts.Node): ts.SourceFile | ts.ModuleBlock => {
  let current = node;
  while (!ts.isSourceFile(current) && !ts.isModuleBlock(current)) {
    current = current.parent;
  }
  return current;
};

const enclosingParameters = (node: ts.Node): ts.TypeParameterDeclaration[] => {
  const parameters = new Map<string, ts.TypeParameterDeclaration>();
  let current = node;
  while (!ts.isSourceFile(current) && !ts.isModuleBlock(current)) {
    if (
      ts.isClassDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionTypeNode(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isMethodSignature(current)
    ) {
      for (const parameter of current.typeParameters ?? []) {
        if (!parameters.has(parameter.name.text)) {
          parameters.set(parameter.name.text, parameter);
        }
      }
    }
    current = current.parent;
  }
  return [...parameters.values()];
};

type Probe = { file: string; position: number; name: string; text: string };
type ProbeOptions = {
  checker: ts.TypeChecker;
  files: ReadonlyMap<string, string>;
  signature: ts.Signature;
  root: ts.Declaration;
  name: string;
};

// Implicit class constructors have no declaration at runtime, despite the
// TypeScript API's non-optional return type. Their owner supplies the scope.
const signatureDeclaration = (
  signature: ts.Signature,
): ts.SignatureDeclaration | undefined => signature.getDeclaration();

const signatureProbe = ({
  checker,
  files,
  signature,
  root,
  name,
}: ProbeOptions): Probe => {
  const inherited = signatureDeclaration(signature);
  const declaration =
    inherited !== undefined && files.has(inherited.getSourceFile().fileName)
      ? inherited
      : root;
  const scope = enclosingScope(declaration);
  const source = scope.getSourceFile();
  const node = checker.signatureToSignatureDeclaration(
    signature,
    ts.SyntaxKind.CallSignature,
    scope,
    ts.NodeBuilderFlags.NoTruncation,
  );
  if (node === undefined || !ts.isCallSignatureDeclaration(node)) {
    panic("Could not represent API call signature");
  }
  const ownNames = new Set(
    node.typeParameters?.map((parameter) => parameter.name.text),
  );
  const parameters = new Map<string, ts.TypeParameterDeclaration>();
  for (const parameter of [
    ...enclosingParameters(root),
    ...enclosingParameters(declaration.parent),
  ]) {
    if (
      !ownNames.has(parameter.name.text) &&
      !parameters.has(parameter.name.text)
    ) {
      parameters.set(parameter.name.text, parameter);
    }
  }
  // Keep parameter bindings and private types in their declaration scope.
  // Returns remain the original program's responsibility; a callable probe
  // compares constructor parameters strictly instead of using bivariance.
  const alias = ts.factory.createTypeAliasDeclaration(
    undefined,
    name,
    [...parameters.values()],
    ts.factory.createTypeLiteralNode([
      ts.factory.updateCallSignature(
        node,
        node.typeParameters,
        node.parameters,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
    ]),
  );
  const text = ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, alias, source);
  return {
    file: source.fileName,
    position: ts.isSourceFile(scope) ? source.end : scope.end - 1,
    name,
    text: withGenericTypeProbes(text, name),
  };
};

const probeType = (program: ts.Program, probe: Probe): ts.Type => {
  const source =
    program.getSourceFile(probe.file) ??
    panic("Missing API signature probe source");
  const checker = program.getTypeChecker();
  let found: ts.TypeAliasDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === probe.name) {
      found = node;
    } else {
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  if (found === undefined) {
    panic("Missing API signature probe declaration");
  }
  const generic = isGenericTypeDeclaration(found)
    ? genericTypeProbe(found)
    : undefined;
  return checker.getTypeFromTypeNode(generic ?? found.type);
};

type SignatureComparisonOptions = {
  checker: ts.TypeChecker;
  files: ReadonlyMap<string, string>;
  openProgram: (files: Map<string, string>) => ts.Program;
  oldLocation: ts.Declaration;
  nextLocation: ts.Declaration;
};

/** Compare inputs strictly without altering the declarations or their returns. */
export const createSignatureInputComparison = ({
  checker,
  files,
  openProgram,
  oldLocation,
  nextLocation,
}: SignatureComparisonOptions) => {
  let sequence = 0;
  const accepts = (old: ts.Signature, next: ts.Signature): boolean => {
    const id = sequence++;
    const before = signatureProbe({
      checker,
      files,
      signature: old,
      root: oldLocation,
      name: `__api_old_call_${id}`,
    });
    const after = signatureProbe({
      checker,
      files,
      signature: next,
      root: nextLocation,
      name: `__api_new_call_${id}`,
    });
    // Never rewrite the authoritative declarations: predicates, typeof a
    // parameter, and conditional types inspecting Parameters must stay intact.
    const augmented = new Map(files);
    for (const probe of [before, after]) {
      const contents =
        augmented.get(probe.file) ??
        panic("API signature probe is outside compared declarations");
      augmented.set(
        probe.file,
        `${contents.slice(0, probe.position)}\n${probe.text}\n${contents.slice(probe.position)}`,
      );
    }
    const program = openProgram(augmented);
    for (const file of new Set([before.file, after.file])) {
      const source =
        program.getSourceFile(file) ?? panic("Missing API signature source");
      const errors = [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source),
      ];
      if (errors.length > 0) {
        panic(
          `API signature probe does not type-check: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n")}`,
        );
      }
    }
    return program
      .getTypeChecker()
      .isTypeAssignableTo(
        probeType(program, after),
        probeType(program, before),
      );
  };
  return accepts;
};
