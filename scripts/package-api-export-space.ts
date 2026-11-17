import { panic } from "better-result";
import ts from "typescript6";

/** `import type` marks the whole clause; TypeScript 6 spells it as a phase. */
const typeOnlyImport = (clause: ts.ImportClause): boolean =>
  clause.phaseModifier === ts.SyntaxKind.TypeKeyword;

type RuntimeExportOptions = { program: ts.Program; file: string; name: string };

// Following alias targets alone erases `export type` and `import type` edges.
// Inspect those edges before asking whether a published name has a value.
export const hasRuntimeExport = ({
  program,
  file,
  name,
}: RuntimeExportOptions): boolean => {
  const checker = program.getTypeChecker();
  const source =
    program.getSourceFile(file) ?? panic(`Missing API entrypoint: ${file}`);
  const seen = new Map<ts.Symbol, Set<string>>();
  const moduleFrom = (node: ts.Expression) => checker.getSymbolAtLocation(node);
  const fromSpecifier = (specifier: ts.ExportSpecifier): boolean => {
    const declaration = specifier.parent.parent;
    if (declaration.isTypeOnly || specifier.isTypeOnly) {
      return false;
    }
    if (declaration.moduleSpecifier !== undefined) {
      const module = moduleFrom(declaration.moduleSpecifier);
      return (
        module !== undefined &&
        fromModule(module, specifier.propertyName?.text ?? specifier.name.text)
      );
    }
    const local = checker.getExportSpecifierLocalTargetSymbol(specifier);
    return local !== undefined && fromLocal(local);
  };
  const fromLocal = (symbol: ts.Symbol): boolean =>
    (symbol.declarations ?? []).some((declaration) => {
      if (ts.isImportSpecifier(declaration)) {
        const clause = declaration.parent.parent;
        if (declaration.isTypeOnly || typeOnlyImport(clause)) {
          return false;
        }
        const module = moduleFrom(clause.parent.moduleSpecifier);
        return (
          module !== undefined &&
          fromModule(
            module,
            declaration.propertyName?.text ?? declaration.name.text,
          )
        );
      }
      if (ts.isImportClause(declaration)) {
        const module = moduleFrom(declaration.parent.moduleSpecifier);
        return (
          !typeOnlyImport(declaration) &&
          module !== undefined &&
          fromModule(module, "default")
        );
      }
      if (ts.isNamespaceImport(declaration)) {
        return !typeOnlyImport(declaration.parent);
      }
      if (ts.isImportEqualsDeclaration(declaration)) {
        return !declaration.isTypeOnly;
      }
      if (ts.isExportSpecifier(declaration)) {
        return fromSpecifier(declaration);
      }
      return (
        !ts.isInterfaceDeclaration(declaration) &&
        !ts.isTypeAliasDeclaration(declaration) &&
        !ts.isTypeParameterDeclaration(declaration)
      );
    });
  const statementsFrom = (module: ts.Symbol): readonly ts.Statement[] =>
    (module.declarations ?? []).flatMap((declaration) => {
      if (ts.isSourceFile(declaration)) {
        return [...declaration.statements];
      }
      if (
        ts.isModuleDeclaration(declaration) &&
        declaration.body !== undefined &&
        ts.isModuleBlock(declaration.body)
      ) {
        return [...declaration.body.statements];
      }
      return [];
    });
  const fromModule = (module: ts.Symbol, exported: string): boolean => {
    const visited = seen.get(module);
    if (visited?.has(exported) === true) {
      return false;
    }
    if (visited === undefined) {
      seen.set(module, new Set([exported]));
    } else {
      visited.add(exported);
    }
    const symbol = checker
      .getExportsOfModule(module)
      .find(({ name: candidate }) => candidate === exported);
    if (symbol === undefined) {
      return false;
    }
    for (const statement of statementsFrom(module)) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) {
          continue;
        }
        if (
          statement.exportClause !== undefined &&
          ts.isNamedExports(statement.exportClause)
        ) {
          const specifier = statement.exportClause.elements.find(
            ({ name: candidate }) => candidate.text === exported,
          );
          if (specifier !== undefined && fromSpecifier(specifier)) {
            return true;
          }
          continue;
        }
        if (
          statement.exportClause !== undefined &&
          ts.isNamespaceExport(statement.exportClause)
        ) {
          if (statement.exportClause.name.text === exported) {
            return true;
          }
          continue;
        }
        if (exported === "default" || statement.moduleSpecifier === undefined) {
          continue;
        }
        const target = moduleFrom(statement.moduleSpecifier);
        if (target !== undefined && fromModule(target, exported)) {
          return true;
        }
      }
    }
    // A directly declared export has no export-specifier edge to inspect.
    // Alias declarations are evaluated above, including type-only ones.
    return (symbol.declarations ?? []).some(
      (declaration) =>
        !ts.isExportSpecifier(declaration) &&
        !ts.isExportDeclaration(declaration) &&
        !ts.isNamespaceExport(declaration) &&
        declaration.getSourceFile() ===
          module.declarations?.at(0)?.getSourceFile() &&
        fromLocal(symbol),
    );
  };
  const module =
    checker.getSymbolAtLocation(source) ??
    panic(`API entrypoint is not a module: ${file}`);
  return fromModule(module, name);
};
