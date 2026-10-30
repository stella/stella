import { createWindowReadCache } from "@/api/lib/files/window-read-cache";
import { LIMITS } from "@/api/lib/limits";

export const docxWindowTextCache = createWindowReadCache<string>({
  maxBytes: LIMITS.mcpWindowTextCacheMaxBytes,
  sizeOf: (text) => text.length * 2,
});

export const extractedWindowTextCache = createWindowReadCache<string>({
  maxBytes: LIMITS.mcpWindowTextCacheMaxBytes,
  sizeOf: (text) => text.length * 2,
});
