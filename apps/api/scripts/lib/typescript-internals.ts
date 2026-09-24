// The only TypeScript compiler internals the web API type printer reads,
// written against typescript 6.0.3. Each accessor checks the shape it relies
// on and panics when a compiler upgrade moves it, so the printer fails loudly
// instead of silently dropping a readonly modifier or a symbol key.

import { panic } from "better-result";
import ts from "typescript";

const SUPPORTED_MAJOR = "6.";
// `CheckFlags.Readonly` in src/compiler/types.ts.
const CHECK_FLAGS_READONLY = 8;

/**
 * Whether a single-bit compiler flag is set. Arithmetic, not `&`: every
 * TypeScript flag enum member used here is one positive bit below 2^31.
 */
export const hasFlag = (flags: number, flag: number): boolean =>
  Math.floor(flags / flag) % 2 === 1;

const readCheckFlags = (property: ts.Symbol): number => {
  if (!ts.version.startsWith(SUPPORTED_MAJOR)) {
    return panic(
      `typescript-internals: written against typescript ${SUPPORTED_MAJOR}x, ` +
        `found ${ts.version}. Re-verify getCheckFlags and symbol links.`,
    );
  }
  const getCheckFlags: unknown = Reflect.get(ts, "getCheckFlags");
  if (typeof getCheckFlags !== "function") {
    return panic(
      "typescript-internals: ts.getCheckFlags is no longer exported",
    );
  }
  const checkFlags: unknown = Reflect.apply(getCheckFlags, undefined, [
    property,
  ]);
  if (typeof checkFlags !== "number") {
    return panic("typescript-internals: getCheckFlags returned a non-number");
  }
  return checkFlags;
};

/**
 * Whether a property is readonly, including properties synthesized by mapped
 * types (`Readonly<T>`, a homomorphic `Omit`), which carry the modifier only in
 * their internal check flags.
 */
export const isReadonlyProperty = (property: ts.Symbol): boolean => {
  if (hasFlag(readCheckFlags(property), CHECK_FLAGS_READONLY)) {
    return true;
  }
  const declaration = property.valueDeclaration ?? property.declarations?.at(0);
  if (declaration === undefined || !ts.canHaveModifiers(declaration)) {
    return false;
  }
  return (
    ts
      .getModifiers(declaration)
      ?.some(({ kind }) => kind === ts.SyntaxKind.ReadonlyKeyword) ?? false
  );
};

/**
 * The unique-symbol type keying a late-bound property (`[sym]: T`) that has no
 * computed-name declaration to read it from, e.g. one produced by a mapped type.
 */
export const lateBoundNameType = (property: ts.Symbol): ts.Type | undefined => {
  const links: unknown = Reflect.get(property, "links");
  if (links === undefined) {
    return undefined;
  }
  if (typeof links !== "object" || links === null) {
    return panic("typescript-internals: symbol links are not an object");
  }
  const nameType: unknown = Reflect.get(links, "nameType");
  if (nameType === undefined) {
    return undefined;
  }
  if (!isType(nameType)) {
    return panic("typescript-internals: links.nameType is not a type");
  }
  return nameType;
};

const isType = (value: unknown): value is ts.Type =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "flags") === "number" &&
  typeof Reflect.get(value, "checker") === "object";
