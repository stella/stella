import { RE2 } from "re2-wasm";

export type CompiledSchemaPattern =
  | { status: "valid"; regex: RE2 }
  | { status: "invalid" };

/** Compile untrusted schema patterns with a linear-time engine, never V8. */
export const compileSchemaPattern = (
  pattern: string,
): CompiledSchemaPattern => {
  try {
    return { status: "valid", regex: new RE2(pattern, "u") };
  } catch {
    return { status: "invalid" };
  }
};
