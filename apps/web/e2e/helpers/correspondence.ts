import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const API_ROOT = path.resolve(import.meta.dirname, "../../../api");

export const CORRESPONDENCE_SMOKE_SUBJECT = "Route smoke correspondence";

// Core has no HTTP creation endpoint. Seed the existing disposable matter;
// its registered workspace cleanup also deletes the correspondence fixture.
export const createTestCorrespondence = async (workspaceId: string) => {
  const correspondenceId = randomUUID();
  await new Promise<undefined>((resolve, reject) => {
    execFile(
      "bun",
      [
        "scripts/seed-route-smoke-correspondence.ts",
        workspaceId,
        correspondenceId,
        CORRESPONDENCE_SMOKE_SUBJECT,
      ],
      {
        cwd: API_ROOT,
        // Seeds run only with local development access open.
        env: { ...process.env, NODE_ENV: "development", STELLA_LOCAL_DEV: "1" },
        timeout: 30_000,
      },
      (error, _stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(`Correspondence seed failed: ${stderr}`, {
              cause: error,
            }),
          );
          return;
        }
        resolve(undefined);
      },
    );
  });
  return correspondenceId;
};
