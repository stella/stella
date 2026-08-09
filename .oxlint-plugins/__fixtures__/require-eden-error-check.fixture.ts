// Passive regression fixture for require-eden-error-check.

import { api } from "@/lib/api";

declare const consume: (value: unknown) => void;

// oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: then does not inspect Eden's error channel
api.tasks.get().then(consume);
// oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: catch is not Eden's HTTP error channel
api.tasks.get().catch(consume);

export const discardedAwait = async () => {
  // oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: bare await discards data and error
  await api.tasks.get();
};

// oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: bare promise discard cannot inspect error
api.tasks.get();
// oxlint-disable-next-line require-eden-error-check/require-eden-error-check -- fixture: void discard cannot inspect error
void api.tasks.get();

export const inspectedLater = async () => {
  const response = await api.tasks.get();
  return response.error;
};

export const unrelatedApi = async (
  // oxlint-disable-next-line eslint/no-shadow -- fixture: proves Eden import matching is binding-aware
  api: {
    tasks: { get: () => Promise<void> };
  },
) => api.tasks.get();
