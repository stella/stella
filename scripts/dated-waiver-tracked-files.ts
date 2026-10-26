import path from "node:path";

import { listTrackedFiles } from "../packages/scripts/src/tracked-files";

export const trackedPolicyFiles = (): string[] =>
  listTrackedFiles(path.resolve(import.meta.dir, ".."));
