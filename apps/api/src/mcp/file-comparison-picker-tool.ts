/**
 * `open_file_comparison`: the MCP App that uploads two .docx files from the
 * user's browser and hands `compare_documents` their staged ids. The tool
 * itself moves no bytes and writes nothing: the panel reserves the slots
 * through `prepare_file_comparison`, PUTs both files, and tells the model the
 * next call. It exists so the model never has to fetch or upload a file.
 */

import * as v from "valibot";

import { FILE_COMPARISON_TRANSPORT } from "@stll/api-contract";

import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import { fileComparisonPermissionDenied } from "@/api/mcp/file-comparison-prepare-tool";
import type {
  TypedMcpToolHandler,
  TypedMcpToolResponse,
} from "@/api/mcp/tool-types";
import {
  nullAsAbsent,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";

export const FILE_COMPARISON_APP_RESOURCE_URI =
  FILE_COMPARISON_TRANSPORT.resourceUri;

const OPEN_FILE_COMPARISON_INPUT_SCHEMA = nullAsAbsent(v.strictObject({}));

const OPEN_FILE_COMPARISON_OUTPUT_SCHEMA = v.strictObject({});

export type OpenFileComparisonOutput = v.InferInput<
  typeof OPEN_FILE_COMPARISON_OUTPUT_SCHEMA
>;

export const OPEN_FILE_COMPARISON_TOOL_DEFINITION = defineValibotMcpTool({
  _meta: {
    ui: {
      resourceUri: FILE_COMPARISON_APP_RESOURCE_URI,
      visibility: ["model", "app"],
    },
  },
  annotations: {
    title: "Open file comparison",
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Open a panel where the user picks two .docx files that are not stored " +
    "in stella; the panel uploads them from the user's browser and reports " +
    "the staged ids for compare_documents. Use this whenever the user wants " +
    "files redlined that are not in a matter and has no HTTPS link to them; " +
    "you cannot upload attached files yourself. Takes no input.",
  inputSchema: OPEN_FILE_COMPARISON_INPUT_SCHEMA,
  access: "write",
  anonymized: { exposure: "excluded", reason: "write" },
  name: FILE_COMPARISON_TRANSPORT.pickerToolName,
  scope: "stella:documents_write",
});

export const OPEN_FILE_COMPARISON_OUTPUT_CONTRACT = defineMcpToolOutput(
  OPEN_FILE_COMPARISON_OUTPUT_SCHEMA,
);

export const handleOpenFileComparisonTool: TypedMcpToolHandler<
  OpenFileComparisonOutput
> = async ({
  args,
  context,
}): Promise<TypedMcpToolResponse<OpenFileComparisonOutput>> => {
  const parsed = v.safeParse(OPEN_FILE_COMPARISON_INPUT_SCHEMA, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  // The panel's own calls are gated too; refusing here spares the user a
  // panel that can only fail.
  if (!hasEffectiveAuthority(context, { entity: ["update"] })) {
    return fileComparisonPermissionDenied();
  }

  return await Promise.resolve(
    toolDataResult({} satisfies OpenFileComparisonOutput, {
      primaryText:
        "Choose the original and the revised .docx in the comparison panel; " +
        "once both are uploaded, run compare_documents with the source it reports.",
    }),
  );
};
