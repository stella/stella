import tailwindcss from "@tailwindcss/postcss";
import { panic } from "better-result";
import path from "node:path";
import { transform } from "oxc-transform-react";
import postcss from "postcss";

import MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages";
import { REACT_COMPILER_OPTIONS } from "@stll/scripts/react-compiler-options";

import readerPackage from "../../decision-reader/package.json";
import {
  READER_MESSAGE_KEYS,
  READER_TEMPLATE_KEYS,
} from "../src/decision-reader/message-keys";
import { MCP_APPS } from "../src/manifest";
import { inspectMcpAppHtml } from "./lib/mcp-app-html-guard";
import {
  inspectMcpReaderUi,
  MCP_READER_UI_APP_DIRECTORIES,
} from "./lib/mcp-reader-ui-guard";

const generatedRoot = path.resolve(
  import.meta.dirname,
  "../src/shared/generated",
);
await Bun.write(
  path.join(generatedRoot, "messages.json"),
  `${JSON.stringify(MCP_APP_MESSAGES, null, 2)}\n`,
);
const styleInput = path.resolve(generatedRoot, "../style.css");
const styles = await postcss([tailwindcss()]).process(
  await Bun.file(styleInput).text(),
  { from: styleInput },
);
const webRoot = path.resolve(import.meta.dirname, "../../../apps/web");
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const readerMessages = new Map<string, Map<string, string>>();
const localeRoot = path.join(webRoot, "src/i18n/langs");
for (const file of [
  ...new Bun.Glob("*.json").scanSync({ cwd: localeRoot }),
].toSorted()) {
  const locale = path.basename(file, ".json");
  const catalogue: unknown = await Bun.file(path.join(localeRoot, file)).json();
  const messages = new Map<string, string>();
  for (const key of [
    ...Object.values(READER_MESSAGE_KEYS),
    ...READER_TEMPLATE_KEYS,
  ]) {
    let value = catalogue;
    for (const segment of key.split(".")) {
      if (typeof value !== "object" || value === null) {
        panic(`Reader message ${key} is missing in ${locale}`);
      }
      value = Reflect.get(value, segment);
    }
    if (typeof value !== "string") {
      panic(`Reader message ${key} is missing in ${locale}`);
    }
    messages.set(key, value);
  }
  readerMessages.set(locale, messages);
}
await Bun.write(
  path.join(generatedRoot, "reader-messages.json"),
  `${JSON.stringify(Object.fromEntries([...readerMessages].map(([locale, messages]) => [locale, Object.fromEntries(messages)])), null, 2)}\n`,
);

// Vite's adapter is specific to Vite hooks; Bun uses the same Oxc transform.
const reactCompiler = {
  name: "react-compiler",
  setup(builder: Bun.PluginBuilder) {
    builder.onLoad({ filter: /\.[jt]sx$/u }, async ({ path: filename }) => {
      if (filename.includes(`${path.sep}node_modules${path.sep}`)) {
        return undefined;
      }
      const result = await transform(
        filename,
        await Bun.file(filename).text(),
        {
          reactCompiler: REACT_COMPILER_OPTIONS,
        },
      );
      if (result.fatal) {
        panic(
          `React Compiler failed for ${filename}: ${result.errors.map(({ message }) => message).join("\n")}`,
        );
      }
      return { contents: result.code, loader: "js" };
    });
  },
} satisfies Bun.BunPlugin;

const inlineReaderFonts = {
  name: "inline-reader-fonts",
  setup(builder: Bun.PluginBuilder) {
    builder.onLoad(
      { filter: /source-serif-4\/.*\.css$/u },
      async ({ path: cssPath }) => {
        let contents = await Bun.file(cssPath).text();
        for (const match of [
          ...contents.matchAll(/url\(\s*["']?([^"'()\s]+)["']?\s*\)/gu),
        ]) {
          const url = match.at(1) ?? panic("Reader font URL has no path");
          if (url.startsWith("data:")) {
            continue;
          }
          if (!url.endsWith(".woff2")) {
            panic(`Unexpected shared reader font asset: ${url}`);
          }
          const bytes = await Bun.file(
            path.resolve(path.dirname(cssPath), url),
          ).arrayBuffer();
          contents = contents.replaceAll(
            match[0],
            () =>
              `url("data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}")`,
          );
        }
        return { contents, loader: "css" };
      },
    );
  },
} satisfies Bun.BunPlugin;
let fonts = await Bun.file(path.join(webRoot, "src/fonts.css")).text();
const paths = [...fonts.matchAll(/url\("(\/fonts\/[^" ]+)"\)/gu)].map((match) =>
  match.at(1),
);
for (const fontPath of paths) {
  if (fontPath === undefined) {
    panic("Font URL has no path");
  }
  const bytes = await Bun.file(
    path.join(webRoot, "public", fontPath),
  ).arrayBuffer();
  fonts = fonts.replaceAll(
    `url("${fontPath}")`,
    () =>
      `url("data:font/woff2;base64,${Buffer.from(bytes).toString("base64")}")`,
  );
}
await Bun.write(
  path.join(generatedRoot, "style.css"),
  `${fonts}\n${styles.css}`,
);

const MCP_APP_DIRECTORIES = MCP_APPS.map(({ directory }) => directory);
const MCP_APP_INPUTS = ["app.html"] as const;
const readerInputGraphs = new Map<string, string[]>();
const buildMcpApp = async ({
  directory,
  input,
}: {
  directory: string;
  input: string;
}): Promise<void> => {
  const appRoot = path.resolve(import.meta.dirname, "../src", directory);
  const app = `${directory}/${input}`;
  const result = await Bun.build({
    root: repoRoot,
    compile: true,
    metafile: true,
    plugins: [reactCompiler, inlineReaderFonts],
    entrypoints: [path.join(appRoot, input)],
    minify: true,
    target: "browser",
  });
  if (!result.success) {
    const messages = result.logs.map(({ message }) => message).join("\n");
    panic(messages || `MCP app build failed for ${app} without a diagnostic`);
  }

  const readerDirectory = MCP_READER_UI_APP_DIRECTORIES.find(
    (name) => name === directory,
  );
  if (readerDirectory !== undefined) {
    const metafile =
      result.metafile ?? panic("Reader build did not report reachable inputs");
    const inputs = Object.keys(metafile.inputs)
      .map((file) => path.relative(repoRoot, path.resolve(file)))
      .filter((file) => /^(?:apps|packages)\//u.test(file))
      .toSorted();
    const loadModule = async (file: string) => ({
      file,
      text: await Bun.file(path.join(repoRoot, file)).text(),
    });
    const sharedFiles = Object.values(readerPackage.exports)
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => `packages/decision-reader/${file.replace(/^\.\//u, "")}`);
    const [sharedModules, astModules, bundleModules] = await Promise.all([
      Promise.all(sharedFiles.map(loadModule)),
      Promise.all(
        [
          "packages/legal-ast/src/document-ast.ts",
          "packages/legal-ast/src/inline.ts",
        ].map(loadModule),
      ),
      Promise.all(
        inputs
          .filter(
            (file) =>
              /\.[cm]?[jt]sx?$/u.test(file) &&
              /^(?:apps|packages)\//u.test(file),
          )
          .map(loadModule),
      ),
    ]);
    const readerIssues = inspectMcpReaderUi({
      sharedModules,
      astModules,
      bundleModules,
    });
    if (readerIssues.length > 0) {
      panic(
        `MCP app ${app} duplicates shared reader UI: ${readerIssues.join(", ")}`,
      );
    }
    readerInputGraphs.set(readerDirectory, inputs);
  }

  const output = result.outputs.at(0);
  if (result.outputs.length !== 1 || output?.kind !== "entry-point") {
    panic(
      `MCP app build for ${app} emitted ${result.outputs.length} outputs; expected one`,
    );
  }

  const canonicalHtml = (await output.text())
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
  const issues = inspectMcpAppHtml(canonicalHtml);
  if (issues.length > 0) {
    panic(
      `MCP app build for ${app} is not self-contained: ${issues.join(", ")}`,
    );
  }

  await Bun.write(
    path.join(appRoot, "generated", `${input}.txt`),
    canonicalHtml,
  );
};

await Promise.all(
  MCP_APP_DIRECTORIES.flatMap((directory) =>
    MCP_APP_INPUTS.map(
      async (input) => await buildMcpApp({ directory, input }),
    ),
  ),
);

const readerGraphs = Object.fromEntries(
  MCP_READER_UI_APP_DIRECTORIES.map((directory) => [
    directory,
    readerInputGraphs.get(directory) ??
      panic(`MCP reader graph was not built for ${directory}`),
  ]),
);
await Bun.write(
  path.join(generatedRoot, "reader-inputs.json"),
  `${JSON.stringify(readerGraphs, null, 2)}\n`,
);

await Bun.write(
  path.resolve(import.meta.dirname, "../src/generated/bundles.ts"),
  [
    "// Generated by build-mcp-apps.ts; do not edit.",
    'import type { MCP_APPS } from "../manifest";',
    ...MCP_APPS.map(
      ({ directory }, index) =>
        `import app${index} from "../${directory}/generated/app.html.txt" with { type: "text" };`,
    ),
    "",
    "export const MCP_APP_BUNDLES = {",
    ...MCP_APPS.map(({ directory }, index) => `  "${directory}": app${index},`),
    '} as const satisfies Record<(typeof MCP_APPS)[number]["directory"], string>;',
    "",
  ].join("\n"),
);
