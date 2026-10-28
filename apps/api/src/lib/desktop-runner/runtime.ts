import { rootDb } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import type { HttpServer } from "@/api/http/context";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import {
  createDesktopRunnerControl,
  type DesktopRunnerControl,
} from "@/api/lib/desktop-runner/control";
import {
  createLocalDoorbell,
  createRedisDoorbell,
  type DesktopRunnerDoorbell,
} from "@/api/lib/desktop-runner/doorbell";
import {
  authorizeRunnerWith,
  createDesktopRunnerGateway,
  type DesktopRunnerGateway,
} from "@/api/lib/desktop-runner/gateway";
import { createRedisClient } from "@/api/lib/redis-client";
import { mintAgentRunToken } from "@/api/mcp/agent-run-token";

/**
 * This process's desktop runner gateway and control, on the owner connection:
 * sockets outlive the request that opened them and leases are swept across
 * organizations, so no member-scoped connection fits. Every query names the
 * account, organization and device key it acts for.
 */

const INSTANCE_ID = `api:${process.pid}:${Bun.randomUUIDv7()}`;

let doorbell: DesktopRunnerDoorbell | null = null;
// Without Redis the API runs as one task, so rings never leave the process.
const getDoorbell = () =>
  (doorbell ??=
    envBase.REDIS_URL === undefined
      ? createLocalDoorbell()
      : createRedisDoorbell({ createClient: createRedisClient }));

let gateway: DesktopRunnerGateway | null = null;
let control: DesktopRunnerControl | null = null;

/** Start accepting runner sockets in this task; called once by the server boot. */
export const startDesktopRunnerGateway = async () => {
  gateway ??= createDesktopRunnerGateway({
    db: rootDb,
    doorbell: getDoorbell(),
    instanceId: INSTANCE_ID,
    authorize: authorizeRunnerWith(authorizeDesktopAccount),
    mintRunToken: mintAgentRunToken,
  });
  await gateway.start();
};

/** Ask every runner socket of this task to reconnect elsewhere. */
export const drainDesktopRunnerGateway = async () => {
  await gateway?.drain();
};

/** A refusal, or `null` once the socket is open. A task not serving sockets refuses. */
export const upgradeDesktopRunner = async (
  request: Request,
  server: HttpServer,
): Promise<Response | null> =>
  gateway === null
    ? new Response("Desktop runners are not served here", { status: 503 })
    : await gateway.upgrade(request, server);

/** What later slices call to run work on a member's computer. */
export const getDesktopRunnerControl = (): DesktopRunnerControl =>
  (control ??= createDesktopRunnerControl({
    db: rootDb,
    doorbell: getDoorbell(),
  }));
