import { rootDb } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import type { HttpServer } from "@/api/http/context";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { desktopKeyLiveness } from "@/api/lib/business-registries/desktop/liveness";
import {
  createDesktopRunnerControl,
  type DesktopRunnerControl,
} from "@/api/lib/desktop-runner/control";
import {
  createLocalDoorbell,
  createLocalRunBell,
  createRedisDoorbell,
  createRedisRunBell,
  type DesktopRunnerDoorbell,
  type DesktopRunnerRunBell,
} from "@/api/lib/desktop-runner/doorbell";
import { runnerFeatureAccess } from "@/api/lib/desktop-runner/feature-access";
import {
  authorizeRunnerWith,
  createDesktopRunnerGateway,
  type DesktopRunnerGateway,
  desktopRunnerUnavailable,
} from "@/api/lib/desktop-runner/gateway";
import { createRedisClient } from "@/api/lib/redis-client";
import { mintAgentRunToken } from "@/api/mcp/agent-run-token";

/**
 * This process's desktop runner gateway, on the owner connection:
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

let runBell: DesktopRunnerRunBell | null = null;
// Readers of a run may sit on any task; without Redis there is only this one.
const getRunBell = () =>
  (runBell ??=
    envBase.REDIS_URL === undefined
      ? createLocalRunBell()
      : createRedisRunBell({ createClient: createRedisClient }));

let control: DesktopRunnerControl | null = null;

/**
 * This process's handle on runs it starts on members' computers, with the
 * bell that wakes it when a run's messages arrive. Every call names the
 * member it acts for.
 */
export const getDesktopRunnerControl = (): {
  control: DesktopRunnerControl;
  runBell: DesktopRunnerRunBell;
} => {
  control ??= createDesktopRunnerControl({
    db: rootDb,
    doorbell: getDoorbell(),
  });
  return { control, runBell: getRunBell() };
};

let gateway: DesktopRunnerGateway | null = null;

/** Start accepting runner sockets in this task; called once by the server boot. */
export const startDesktopRunnerGateway = async () => {
  gateway ??= createDesktopRunnerGateway({
    db: rootDb,
    doorbell: getDoorbell(),
    runBell: getRunBell(),
    instanceId: INSTANCE_ID,
    authorize: authorizeRunnerWith(authorizeDesktopAccount),
    mintRunToken: mintAgentRunToken,
    isKeyLive: desktopKeyLiveness(rootDb),
    isRunnerEnabled: runnerFeatureAccess({ db: rootDb }),
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
    ? desktopRunnerUnavailable({
        reason: "This task does not serve runner sockets",
        body: "Desktop runners are not served here",
      })
    : await gateway.upgrade(request, server);
