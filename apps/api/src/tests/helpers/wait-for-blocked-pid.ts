import { panic } from "better-result";
import type { SQL } from "bun";

// Observe the server lock wait before releasing or terminating either session.
export const waitForBlockedPid = async (
  observer: SQL,
  { waitingPid, holdingPid }: { waitingPid: number; holdingPid: number },
) => {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    // db-await-in-loop: bounded catalog barrier proves a lock wait before injecting cancellation.
    const rows = await observer<
      { waiting: boolean }[]
    >`select ${holdingPid} = any(pg_blocking_pids(${waitingPid})) as waiting`;
    if (rows.at(0)?.waiting === true) {
      return;
    }
  }
  panic(`Session ${waitingPid} did not wait for ${holdingPid}`);
};
