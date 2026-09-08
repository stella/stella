/**
 * Live stella-docs retrieval eval. It talks to the server through MCP stdio,
 * lists the production tool schemas and descriptions, then exercises the
 * documented search-to-chunks workflow and two formerly HTML-heavy page URLs.
 * This deterministic check measures the retrieval contract, not model success.
 *
 * Run against this checkout:
 *   bun run eval:retrieval -- --label after
 *
 * Compare another checkout without copying its schemas or handlers:
 *   bun run eval:retrieval -- --label before --server /path/to/.claude/mcp/stella-docs.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 30_000;
const args = process.argv.slice(2);

const argumentValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args.at(index + 1);
};

const label = argumentValue("--label") ?? "current";
const serverEntry = path.resolve(
  argumentValue("--server") ??
    path.join(import.meta.dirname, "..", "stella-docs.ts"),
);
const transport = new StdioClientTransport({
  args: ["run", serverEntry],
  command: "bun",
  cwd: path.dirname(serverEntry),
  stderr: "inherit",
});
const client = new Client({ name: "stella-docs-eval", version: "1.0.0" });

const resultText = ({ content }: CallToolResult): string =>
  content
    .flatMap((item) =>
      item.type === "text" && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n");

const isCallToolResult = (result: unknown): result is CallToolResult =>
  isRecord(result) && Array.isArray(result["content"]);

const callTool = async (
  name: string,
  toolArguments: Record<string, unknown>,
): Promise<CallToolResult> => {
  const result = await client.callTool(
    { name, arguments: toolArguments },
    undefined,
    {
      timeout: REQUEST_TIMEOUT_MS,
    },
  );
  if (!isCallToolResult(result)) {
    throw new Error(`Tool ${name} returned a task instead of content`);
  }
  return result;
};

const looksLikeHtml = (text: string): boolean =>
  /<!doctype\s+html\b|<html\b/iu.test(text.slice(0, 2048));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

try {
  await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
  const listed = await client.listTools(undefined, {
    timeout: REQUEST_TIMEOUT_MS,
  });
  const descriptions = Object.fromEntries(
    listed.tools.map(({ description, name }) => [name, description ?? ""]),
  );
  const sourceList = await callTool("list_doc_sources", {});
  const sourceListText = resultText(sourceList);
  const selectedSource = sourceListText.includes("TanStackQuery:")
    ? "TanStackQuery"
    : "TanStack";

  const rejectedInput = { url: "not-a-url" };
  let rejectionMessage = "";
  let schemaRejected = false;
  try {
    const rejected = await callTool("fetch_docs", rejectedInput);
    rejectionMessage = resultText(rejected);
    schemaRejected = rejected.isError === true;
  } catch (error) {
    rejectionMessage =
      error instanceof Error ? error.message : "Unknown schema rejection";
    schemaRejected = true;
  }

  const pageUrls = [
    "https://tanstack.com/query/latest/docs/framework/react/guides/query-options",
    "https://oxc.rs/docs/guide/usage/linter/js-plugins.html",
  ];
  const pageResults = [];
  for (const url of pageUrls) {
    const input = { url };
    const result = await callTool("fetch_docs", input);
    const text = resultText(result);
    pageResults.push({
      chars: text.length,
      input,
      isError: result.isError === true,
      rawHtml: looksLikeHtml(text),
      readableAndBounded:
        result.isError !== true &&
        !looksLikeHtml(text) &&
        text.length <= 12_000,
    });
  }

  const searchInput = {
    maxResults: 1,
    query: "react query options",
    sources: [selectedSource],
  };
  const search = await callTool("search_docs", searchInput);
  const searchText = resultText(search);
  const selected: unknown = JSON.parse(searchText);
  if (!isUnknownArray(selected)) {
    throw new TypeError("search_docs did not return a result array");
  }
  const first = selected.at(0);
  const selectedUrl = isRecord(first) ? first["url"] : undefined;
  if (typeof selectedUrl !== "string") {
    throw new TypeError("search_docs did not return a page URL");
  }
  const chunksInput = {
    maxChunks: 3,
    query: "query options type inference",
    url: selectedUrl,
  };
  const chunks = await callTool("fetch_doc_chunks", chunksInput);
  const chunksText = resultText(chunks);
  const containsGuidance =
    chunksText.includes("One of the best ways to share") &&
    chunksText.includes("queryOptions(") &&
    chunksText.includes("queryClient.setQueryData(");

  process.stdout.write(
    `${JSON.stringify(
      {
        label,
        pages: pageResults,
        schemaRejection: {
          input: rejectedInput,
          rejected: schemaRejected,
          rejectionMessage,
        },
        workflow: {
          chunks: {
            chars: chunksText.length,
            input: chunksInput,
            isError: chunks.isError === true,
            rawHtml: looksLikeHtml(chunksText),
            containsGuidance,
            succeeded:
              chunks.isError !== true &&
              !looksLikeHtml(chunksText) &&
              containsGuidance,
          },
          search: {
            chars: searchText.length,
            input: searchInput,
            isError: search.isError === true,
            succeeded: search.isError !== true,
          },
          selectedSource,
          selectedUrl,
          startsAtSearch:
            descriptions["search_docs"]?.includes(
              "Start documentation retrieval",
            ) ?? false,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close();
}
