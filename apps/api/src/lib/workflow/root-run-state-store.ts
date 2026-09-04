import {
  createLazyRedisClient,
  createRedisClient,
} from "@/api/lib/redis-client";
import { withTimeout } from "@/api/lib/with-timeout";
import { createWorkflowRunStateStore } from "@/api/lib/workflow/run-state-store";

// The store binds one connection for its lifetime, and this one is the
// process-wide instance every workflow path reaches for. Bind it to the
// holder rather than to a client, so a connection that closes is replaced on
// the next command instead of stranding the store on a dead socket.
const rootRedis = createLazyRedisClient(() => createRedisClient());

// The client reconnects for as long as an outage lasts and queues commands
// while it does, so the bound is what stops a workflow step from waiting out
// the whole outage inside one command. It covers the connect too: a caller
// that arrives while the holder is still climbing its cold-start ladder gets
// a failure it can retry rather than the ladder's full length.
const ROOT_COMMAND_TIMEOUT_MS = 2000;

const sendRootCommand = async (
  command: string,
  args: string[],
): Promise<unknown> =>
  await withTimeout(
    async (): Promise<unknown> =>
      await (await rootRedis.ready()).send(command, args),
    { label: "workflow run state command", timeoutMs: ROOT_COMMAND_TIMEOUT_MS },
  );

let rootWorkflowRunStateStore: ReturnType<
  typeof createWorkflowRunStateStore
> | null = null;

export const getRootWorkflowRunStateStore = () => {
  rootWorkflowRunStateStore ??= createWorkflowRunStateStore({
    send: sendRootCommand,
  });
  return rootWorkflowRunStateStore;
};
