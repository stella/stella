import { sha256Hex } from "../../packages/sha256/src/node";

export const CLASSIFICATIONS = ["ordinary", "support", "priority"] as const;
export const sha256 = sha256Hex;
