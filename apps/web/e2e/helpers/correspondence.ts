import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const API_ROOT = path.resolve(import.meta.dirname, "../../../api");

export const CORRESPONDENCE_SMOKE_SUBJECT = "Route smoke correspondence";

// Core has no HTTP creation endpoint. Seed the existing disposable matter;
// its registered workspace cleanup also deletes the correspondence fixture.
export const createTestCorrespondence = async (workspaceId: string) => {
  const correspondenceId = randomUUID();
  await execFileAsync(
    "bun",
    [
      "scripts/seed-route-smoke-correspondence.ts",
      workspaceId,
      correspondenceId,
      CORRESPONDENCE_SMOKE_SUBJECT,
    ],
    { cwd: API_ROOT, timeout: 30_000 },
  );
  return correspondenceId;
};
