import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { MCP_MAX_REQUEST_BODY_BYTES } from "@/api/mcp/constants";

/**
 * Ceilings on the two ways a DOCX reaches `save_template`. Owned here rather
 * than in the tool module so the workflow reference renders the same numbers
 * the schema enforces instead of restating them in prose.
 */

// A JSON-RPC request has a 512 KiB transport cap. Reserve half for the
// envelope and the remaining tool arguments, then derive the base64 payload
// ceiling from the part that can safely reach the validator.
export const MAX_INLINE_DOCX_BASE64_LENGTH = Math.floor(
  MCP_MAX_REQUEST_BODY_BYTES / 2,
);

export const MAX_INLINE_DOCX_BYTES = Math.floor(
  (MAX_INLINE_DOCX_BASE64_LENGTH / 4) * 3,
);

/** Derived so the advertised ceiling cannot drift from the enforced one. */
export const MAX_DOCX_MEGABYTES = Math.floor(
  FILE_SIZE_LIMIT_BYTES.document / (1024 * 1024),
);
