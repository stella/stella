import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

// Source censuses must never observe transient test modules.
export const createTestMutantDirectory = (prefix: string) => {
  const root = path.resolve(import.meta.dir, "../../../.test-mutants");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, prefix));
};
