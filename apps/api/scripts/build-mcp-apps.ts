import "../src/tests/setup-env";
import tailwindcss from "@tailwindcss/postcss";
import { panic } from "better-result";
import path from "node:path";
import postcss from "postcss";

import { MCP_APP_OUTPUT_SCHEMAS } from "../src/mcp/app-contracts";
import { MCP_APPS } from "../src/mcp/apps/manifest";
import { defineChatProjectionMcpToolOutput } from "../src/mcp/valibot-tool-definition";
import { buildMcpAppMessages } from "./lib/mcp-app-catalog";
import { inspectMcpAppHtml } from "./lib/mcp-app-html-guard";

const generatedRoot = path.resolve(
  import.meta.dirname,
  "../src/mcp/apps/shared/generated",
);
await Bun.write(
  path.join(generatedRoot, "messages.json"),
  `${JSON.stringify(await buildMcpAppMessages(), null, 2)}\n`,
);
const schemas = Object.fromEntries(
  Object.entries(MCP_APP_OUTPUT_SCHEMAS).map(([name, schema]) => [
    name,
    defineChatProjectionMcpToolOutput(schema).outputSchema,
  ]),
);
await Bun.write(
  path.join(generatedRoot, "schemas.json"),
  `${JSON.stringify(schemas, null, 2)}\n`,
);
const styleInput = path.resolve(generatedRoot, "../style.css");
const styles = await postcss([tailwindcss()]).process(
  await Bun.file(styleInput).text(),
  { from: styleInput },
);
const webRoot = path.resolve(import.meta.dirname, "../../web");
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
const buildMcpApp = async ({
  directory,
  input,
}: {
  directory: string;
  input: string;
}): Promise<void> => {
  const appRoot = path.resolve(
    import.meta.dirname,
    "../src/mcp/apps",
    directory,
  );
  const app = `${directory}/${input}`;
  const result = await Bun.build({
    compile: true,
    entrypoints: [path.join(appRoot, input)],
    minify: true,
    target: "browser",
  });
  if (!result.success) {
    const messages = result.logs.map(({ message }) => message).join("\n");
    panic(messages || `MCP app build failed for ${app} without a diagnostic`);
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
