import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

/** A Rust source file under `src-tauri/src`. */
export const readNativeSource = (file: string) =>
  readFileSync(path.join(import.meta.dir, "../src-tauri/src", file), "utf-8");

const camelCase = (variant: string) =>
  `${variant.charAt(0).toLowerCase()}${variant.slice(1)}`;

/** Variant names of a plain Rust enum, read from its declaration. */
export const rustEnumVariants = (source: string, name: string) => {
  const body = new RegExp(`pub enum ${name} \\{([^}]*)\\}`, "u").exec(
    source,
  )?.[1];
  if (body === undefined) {
    panic(`Missing enum ${name}`);
  }
  return [...body.matchAll(/^\s*(\w+),/gmu)].map((match) =>
    camelCase(match[1] ?? ""),
  );
};
