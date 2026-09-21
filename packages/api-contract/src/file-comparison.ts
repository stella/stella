/**
 * The tools a client drives to redline two DOCX files stella does not store,
 * and the MCP App that uploads them from the user's browser. One place names
 * them so the server, the panel and the CLI cannot disagree on a tool name.
 */
export const FILE_COMPARISON_TRANSPORT = {
  compareToolName: "compare_documents",
  linksToolName: "prepare_file_comparison_from_links",
  pickerToolName: "open_file_comparison",
  prepareToolName: "prepare_file_comparison",
  resourceUri: "ui://stella/file-comparison",
} as const;
