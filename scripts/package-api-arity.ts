import { panic } from "better-result";
import ts from "typescript6";

import { hasTypeScriptFlag } from "./package-api-compatibility";
import {
  type createSignatureInputComparison,
  signatureDeclaration,
} from "./package-api-signature-comparison";

const tupleType = (
  checker: ts.TypeChecker,
  type: ts.Type,
): type is ts.TupleTypeReference => checker.isTupleType(type);

const restMaximum = (checker: ts.TypeChecker, type: ts.Type): number => {
  // A tuple rest can be finite, including one reached through a generic
  // constraint. Array rests and variadic arrays accept arbitrarily many args.
  const constraint = checker.getBaseConstraintOfType(type);
  if (constraint !== undefined && constraint !== type) {
    return restMaximum(checker, constraint);
  }
  if (type.isUnion()) {
    return Math.max(
      ...type.types.map((member) => restMaximum(checker, member)),
    );
  }
  if (!tupleType(checker, type)) {
    return Infinity;
  }
  const arguments_ = checker.getTypeArguments(type);
  let count = 0;
  for (const [index, flag] of type.target.elementFlags.entries()) {
    if (hasTypeScriptFlag(flag, ts.ElementFlags.Rest)) {
      return Infinity;
    }
    if (!hasTypeScriptFlag(flag, ts.ElementFlags.Variadic)) {
      count += 1;
      continue;
    }
    const argument =
      arguments_[index] ?? panic("Missing variadic tuple argument");
    count += restMaximum(checker, argument);
  }
  return count;
};

const maximumArguments = (
  checker: ts.TypeChecker,
  signature: ts.Signature,
): number => {
  const declaration = signatureDeclaration(signature);
  if (declaration === undefined || !ts.hasRestParameter(declaration)) {
    return signature.parameters.length;
  }
  const rest =
    signature.parameters.at(-1) ?? panic("Missing API rest parameter");
  return (
    signature.parameters.length -
    1 +
    restMaximum(checker, checker.getTypeOfSymbol(rest))
  );
};

type ArityComparisonOptions = {
  checker: ts.TypeChecker;
  accepts: ReturnType<typeof createSignatureInputComparison>;
};

/** Accepted argument counts supplement TypeScript's callback assignability. */
export const createCallArityComparison =
  ({ checker, accepts }: ArityComparisonOptions) =>
  (oldType: ts.Type, nextType: ts.Type, label: string): string[] => {
    const problems: string[] = [];
    for (const [kind, prefix] of [
      [ts.SignatureKind.Call, ""],
      [ts.SignatureKind.Construct, "new "],
    ] as const) {
      const next = checker.getSignaturesOfType(nextType, kind);
      for (const old of checker.getSignaturesOfType(oldType, kind)) {
        const maximum = maximumArguments(checker, old);
        const candidates = next.filter(
          (signature) => maximumArguments(checker, signature) >= maximum,
        );
        // Existing assignability already proves a type-compatible match when
        // every new signature also accepts the old argument counts.
        if (candidates.length === next.length && candidates.length > 0) {
          continue;
        }
        if (!candidates.some((candidate) => accepts(old, candidate))) {
          problems.push(
            `${prefix}${label}: removed accepted argument count from a call signature`,
          );
        }
      }
    }
    return problems;
  };
