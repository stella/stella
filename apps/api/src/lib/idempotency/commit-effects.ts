import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A side effect owed only once a write is durable: a notification fan-out, a
 * search-repair nudge, anything another reader acts on. It must not throw;
 * asynchronous work inside it stays detached and captured.
 */
type CommitEffect = () => void;

type CommitEffectScope = {
  state: "open" | "committed" | "rolled-back";
  effects: CommitEffect[];
};

const commitEffectScope = new AsyncLocalStorage<CommitEffectScope>();

/**
 * Run `effect` once the writes the caller has just made are committed.
 *
 * A handler that owns its transactions calls this after its last `safeDb`
 * call returns, so outside a request receipt the effect runs at once. Under a
 * replayable request, every handler transaction is a savepoint of the
 * receipt's transaction, so "returned" is not "committed": the effect waits
 * for the receipt to commit, and is dropped if it rolls back. A replayed
 * request never reruns the handler, so its effects happen exactly once.
 */
export const afterCommit = (effect: CommitEffect): void => {
  const scope = commitEffectScope.getStore();
  if (scope === undefined || scope.state === "committed") {
    effect();
    return;
  }
  if (scope.state === "open") {
    scope.effects.push(effect);
  }
};

/**
 * Run `transaction` with commit effects deferred, then release them only when
 * `committed` says the transaction's writes are durable.
 */
export const withDeferredCommitEffects = async <T>(
  transaction: () => Promise<T>,
  committed: (value: T) => boolean,
): Promise<T> => {
  const scope: CommitEffectScope = { state: "open", effects: [] };
  let durable = false;
  try {
    const value = await commitEffectScope.run(scope, transaction);
    durable = committed(value);
    return value;
  } finally {
    // A throw or an uncommitted result drops the effects; detached work that
    // registers one later is dropped too.
    const effects = scope.effects.splice(0);
    scope.state = durable ? "committed" : "rolled-back";
    if (durable) {
      for (const effect of effects) {
        effect();
      }
    }
  }
};
