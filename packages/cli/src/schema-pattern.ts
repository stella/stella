export type CompiledSchemaPattern =
  | { status: "valid"; regex: RegExp }
  | { status: "invalid" };

/** Compile an untrusted JSON-Schema pattern without allowing SyntaxError out. */
export const compileSchemaPattern = (
  pattern: string,
): CompiledSchemaPattern => {
  try {
    return { status: "valid", regex: new RegExp(pattern, "u") };
  } catch {
    return { status: "invalid" };
  }
};
