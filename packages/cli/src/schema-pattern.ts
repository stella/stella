import { RE2 } from "re2-wasm";

export type CompiledSchemaPattern =
  | { status: "valid"; regex: RE2 }
  | { status: "invalid" };

const SUPPORTED_FLAGS: ReadonlySet<string> = new Set("dgimsuy");

const flagsAreSupported = (flags: string): boolean => {
  const seen = new Set<string>();
  for (const flag of flags) {
    if (!SUPPORTED_FLAGS.has(flag) || seen.has(flag)) {
      return false;
    }
    seen.add(flag);
  }
  return true;
};

/** Compile untrusted schema patterns with a linear-time engine, never V8. */
export const compileSchemaPattern = (
  pattern: string,
  flags = "",
): CompiledSchemaPattern => {
  if (!flagsAreSupported(flags)) {
    return { status: "invalid" };
  }
  try {
    const unicodeFlags = flags.includes("u") ? flags : `${flags}u`;
    return { status: "valid", regex: new RE2(pattern, unicodeFlags) };
  } catch {
    return { status: "invalid" };
  }
};
