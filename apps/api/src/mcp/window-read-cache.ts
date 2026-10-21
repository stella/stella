import { LIMITS } from "@/api/lib/limits";
import { createWindowReadCache } from "@/api/lib/window-read-cache";

export const docxWindowTextCache = createWindowReadCache<string>({
  maxBytes: LIMITS.mcpWindowTextCacheMaxBytes,
  sizeOf: (text) => text.length * 2,
});

export const extractedWindowTextCache = createWindowReadCache<string>({
  maxBytes: LIMITS.mcpWindowTextCacheMaxBytes,
  sizeOf: (text) => text.length * 2,
});
