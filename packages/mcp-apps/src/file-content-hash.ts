import { sha256Hex } from "@stll/sha256/browser";

export const hashUploadFile = async (file: File) => await sha256Hex(file);
