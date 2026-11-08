import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTranslator } from "use-intl";
import { _createCache, _createIntlFormatters } from "use-intl/core";
import formatSourceMessage from "use-intl/format-message";
import formatCompiledMessage from "use-intl/format-message/format-only";

import MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages";

import readerCatalogues from "../../src/shared/generated/reader-messages.json";
import {
  precompileCatalogue,
  precompiledMessagesPlugin,
  precompileMessage,
} from "./precompiled-messages";

type Catalogue = { readonly [key: string]: string | Catalogue };
type Message = { path: readonly string[]; source: string };

const messagesOf = (catalogue: Catalogue, prefix: readonly string[] = []) =>
  Object.entries(catalogue).flatMap(([key, value]): Message[] =>
    typeof value === "string"
      ? [{ path: [...prefix, key], source: value }]
      : messagesOf(value, [...prefix, key]),
  );

// Every argument a message names gets a marked value and every tag wraps its
// chunks, so a formatter that drops or reorders either changes the text.
const valuesFor = (message: string) =>
  Object.fromEntries([
    ...[...message.matchAll(/\{\s*(\w+)/gu)].map(
      ([, name = ""]) => [name, `«${name}»`] as const,
    ),
    ...[...message.matchAll(/<(\w+)>/gu)].map(
      ([, tag = ""]) =>
        [
          tag,
          (chunks: unknown) => `<${tag}>${textOf(chunks)}</${tag}>`,
        ] as const,
    ),
  ]);

const textOf = (formatted: unknown): string =>
  Array.isArray(formatted) ? formatted.map(textOf).join("") : String(formatted);

const PARITY_CASES = [
  ["app", MCP_APP_MESSAGES],
  ["reader", readerCatalogues],
] as const;

const APP_MESSAGES_FILE =
  /[/\\]api-contract[/\\]src[/\\]mcp-app-messages\.json$/u;

describe("precompiled MCP app messages", () => {
  test.each(PARITY_CASES)(
    "%s catalogues format the same text precompiled in every locale",
    (_, catalogues) => {
      const messages = messagesOf(catalogues);
      expect(messages.length).toBeGreaterThan(0);
      for (const { path: keys, source } of messages) {
        const [locale = ""] = keys;
        const key = keys.join(".");
        const options = {
          cache: _createCache(),
          formatters: _createIntlFormatters(_createCache()),
          locale,
          timeZone: "UTC",
        };
        const values = valuesFor(source);
        const expected = textOf(
          formatSourceMessage(key, source, values, options),
        );
        const actual = textOf(
          formatCompiledMessage(
            key,
            precompileMessage(source, key),
            values,
            options,
          ),
        );
        expect({ key, text: actual }).toEqual({ key, text: expected });
      }
    },
  );

  test("plain text stays the same string, so direct catalogue reads keep their text", () => {
    const catalogue = { en: { title: "Case law", note: "l'arrêt" } };
    expect(precompileCatalogue(catalogue)).toEqual(catalogue);
  });

  test("a message whose compiled text differs from a direct read is refused", () => {
    expect(() => precompileCatalogue({ en: { quote: "It''s" } })).toThrow(
      "Message en.quote reads differently once compiled",
    );
  });

  test("invalid ICU is refused with its catalogue path", () => {
    expect(() => precompileCatalogue({ en: { broken: "{count" } })).toThrow(
      "Message en.broken is not valid ICU",
    );
  });

  test("a bundle translates through the format-only entry without the ICU parser", async () => {
    const translator = Bun.resolveSync("use-intl", import.meta.dirname);
    const catalogue = Bun.resolveSync(
      "@stll/api-contract/mcp-app-messages",
      import.meta.dirname,
    );
    const { metafile, outputs, success } = await Bun.build({
      entrypoints: ["precompiled-messages:entry"],
      metafile: true,
      target: "browser",
      format: "esm",
      plugins: [
        {
          name: "entry",
          setup(builder) {
            builder.onResolve(
              { filter: /^precompiled-messages:/u },
              (args) => ({
                path: args.path,
                namespace: "entry",
              }),
            );
            builder.onLoad({ filter: /.*/u, namespace: "entry" }, () => ({
              loader: "js",
              contents: [
                `import { createTranslator } from ${JSON.stringify(translator)};`,
                `import messages from ${JSON.stringify(catalogue)};`,
                `export const text = createTranslator({ locale: "cs", messages: messages.cs })("keywordsOmitted", { count: 3 });`,
              ].join("\n"),
            }));
          },
        },
        precompiledMessagesPlugin([
          { file: APP_MESSAGES_FILE, catalogue: MCP_APP_MESSAGES },
        ]),
      ],
    });
    expect(success).toBe(true);
    const inputs = Object.keys(metafile?.inputs ?? {});
    expect(
      inputs.some((file) => file.endsWith("format-message/format-only.js")),
    ).toBe(true);
    expect(
      inputs.filter((file) =>
        /[/\\](?:intl-messageformat|icu-messageformat-parser)[/\\]/u.test(file),
      ),
    ).toEqual([]);

    const directory = await mkdtemp(path.join(tmpdir(), "mcp-messages-"));
    try {
      const bundle = path.join(directory, "bundle.mjs");
      await Bun.write(bundle, (await outputs.at(0)?.text()) ?? "");
      const { text }: { text: unknown } = await import(bundle);
      expect(text).toBe(
        createTranslator({ locale: "cs", messages: MCP_APP_MESSAGES.cs })(
          "keywordsOmitted",
          { count: 3 },
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
