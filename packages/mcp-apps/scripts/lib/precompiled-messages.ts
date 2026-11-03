import { panic, Result } from "better-result";
import compileMessage from "icu-minify/compile";
import type { CompiledMessage } from "icu-minify/format";

/**
 * Compiles one ICU message to the form use-intl's format-only entry reads.
 * A message without ICU syntax compiles to its own text, which code that
 * reads a catalogue entry directly relies on.
 */
export const precompileMessage = (
  message: string,
  label: string,
): CompiledMessage => {
  const result = Result.try(() => compileMessage(message));
  if (!result.isOk()) {
    return panic(`Message ${label} is not valid ICU`, result.error);
  }
  const compiled = result.value;
  if (typeof compiled === "string" && compiled !== message) {
    panic(
      `Message ${label} reads differently once compiled; a direct read of the catalogue would show ${JSON.stringify(message)}`,
    );
  }
  return compiled;
};

/**
 * Compiles every message of a catalogue, so the apps format messages
 * without shipping the ICU parser.
 */
export const precompileCatalogue = (
  catalogue: unknown,
  label = "",
): unknown => {
  if (typeof catalogue === "string") {
    return precompileMessage(catalogue, label);
  }
  if (
    typeof catalogue !== "object" ||
    catalogue === null ||
    Array.isArray(catalogue)
  ) {
    return panic(`Message ${label} is neither text nor a catalogue`);
  }
  return Object.fromEntries(
    Object.entries(catalogue).map(([key, value]) => [
      key,
      precompileCatalogue(value, label === "" ? key : `${label}.${key}`),
    ]),
  );
};

const USE_INTL_FORMAT_MESSAGE = "use-intl/format-message";

/**
 * Bundles carry precompiled catalogues and use-intl's format-only message
 * formatter. Source and tests keep the readable catalogues and the parsing
 * formatter; both format a message the same way.
 */
export const precompiledMessagesPlugin = (
  catalogues: readonly { file: RegExp; catalogue: unknown }[],
): Bun.BunPlugin => {
  const compiled = catalogues.map(({ file, catalogue }) => ({
    file,
    contents: JSON.stringify(precompileCatalogue(catalogue)),
  }));
  return {
    name: "precompiled-mcp-messages",
    setup(builder) {
      builder.onResolve(
        { filter: new RegExp(`^${USE_INTL_FORMAT_MESSAGE}$`, "u") },
        ({ resolveDir }) => ({
          path: Bun.resolveSync(
            `${USE_INTL_FORMAT_MESSAGE}/format-only`,
            resolveDir,
          ),
        }),
      );
      for (const { file, contents } of compiled) {
        builder.onLoad({ filter: file }, () => ({ contents, loader: "json" }));
      }
    },
  };
};
