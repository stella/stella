import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { createEntityVersionFromBuffer } from "@/api/handlers/entities/create-version-from-buffer";

/** Narrow persistence seam shared by template MCP handlers and their tests. */
export const persistFilledTemplateDocument = createEntityFromBuffer;
export const persistFilledTemplateVersion = createEntityVersionFromBuffer;
