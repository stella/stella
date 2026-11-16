// Where the stand-in computer (`agent-local-runner.ts`) keeps its state and
// the files that switch it, without the process handling that starts it, so
// browser tests in a Node runtime can read and flip them.

import path from "node:path";

import { DEV_STATE_DIR } from "./dev-runtime";

const STATE_DIR = "local-runner";

/**
 * The files a test or a person creates in the state folder to change the
 * stand-in computer: `offline` takes it offline until removed, `relink`
 * links it again with a new device key (the stand-in removes it once linked).
 */
export const LOCAL_RUNNER_SWITCHES = {
  offline: "offline",
  relink: "relink",
} as const;

/** The link the stand-in redeemed, with its computer's desktop id. */
export const LOCAL_RUNNER_LINK_FILE = "link.json";

/** Written by the stand-in: its folder under the development app's data. */
export const LOCAL_RUNNER_DATA_FOLDER_FILE = "data-folder";

export const localRunnerDir = (root: string) =>
  path.join(root, DEV_STATE_DIR, STATE_DIR);
