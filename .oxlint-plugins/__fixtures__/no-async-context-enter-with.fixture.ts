// Passive regression fixture for
// `no-async-context-enter-with/no-async-context-enter-with`.

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<{ count: number }>();

// MUST flag: binding through the ambient frame leaks the store to whatever the
// runtime dispatches next.
// oxlint-disable-next-line no-async-context-enter-with/no-async-context-enter-with -- fixture: enterWith must be rejected
export const begin = (): void => store.enterWith({ count: 0 });

// MUST flag: an alias is the same call.
const aliased = store;
// oxlint-disable-next-line no-async-context-enter-with/no-async-context-enter-with -- fixture: aliased enterWith must be rejected
export const beginAliased = (): void => aliased.enterWith({ count: 0 });

// Allowed: `run` restores the previous frame when the callback returns.
export const withStore = <TResult>(fn: () => TResult): TResult =>
  store.run({ count: 0 }, fn);
