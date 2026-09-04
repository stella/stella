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
//
// Run state is a lock and its bookkeeping, so a command that outlived its
// caller must not be applied: a queued `tryClaim` would acquire a workspace
// for a request that has already failed, and a queued `clear` would delete
// the state of whichever run claimed it next. The queue is therefore off
// here. The pre-connect rejection that opting out otherwise causes cannot
// happen through this holder: `ready()` awaits the connection before any
// caller is handed the client.
const rootRedis = createLazyRedisClient(() =>
  createRedisClient({ enableOfflineQueue: false }),
);

// The connect climbs a cold-start ladder longer than any one command should
// wait behind, so the bound is what stops a workflow step from waiting out an
// outage inside one command.
const ROOT_COMMAND_TIMEOUT_MS = 2000;

type RootRunStateRedis = {
  send: (command: string, args: string[]) => Promise<unknown>;
};

/**
 * The store's command path, bounded. Exported as its own seam so a test can
 * drive a connection that arrives after the deadline; production has the one
 * caller below.
 */
export const createRootRunStateSend =
  (
    ready: () => Promise<RootRunStateRedis>,
    timeoutMs = ROOT_COMMAND_TIMEOUT_MS,
  ) =>
  async (command: string, args: string[]): Promise<unknown> =>
    await withTimeout(
      async (signal): Promise<unknown> => {
        const client = await ready();
        // The connect can outlast the deadline, and `withTimeout` has failed
        // the caller by then. Sending here would apply a command whose caller
        // was already told it had not run. A command that did reach a live
        // connection is left to complete: it is the send, not the reply, that
        // decides whether the run state moved.
        signal.throwIfAborted();
        return await client.send(command, args);
      },
      { label: "workflow run state command", timeoutMs },
    );

const sendRootCommand = createRootRunStateSend(rootRedis.ready);

let rootWorkflowRunStateStore: ReturnType<
  typeof createWorkflowRunStateStore
> | null = null;

export const getRootWorkflowRunStateStore = () => {
  rootWorkflowRunStateStore ??= createWorkflowRunStateStore({
    send: sendRootCommand,
  });
  return rootWorkflowRunStateStore;
};
