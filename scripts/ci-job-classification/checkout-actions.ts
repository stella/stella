/**
 * Actions that check a repository out: GitHub's own, and the shared wrapper
 * that retries a blobless checkout and forwards every input to it. A step
 * using either reads the same `ref`, `repository`, `path` and credential
 * inputs. This module imports nothing, so the classification tooling's sparse
 * checkout can load it on its own.
 */
const REPOSITORY_CHECKOUT_ACTIONS = [
  "actions/checkout@",
  "stella/.github/actions/partial-clone-checkout@",
] as const;

export const isRepositoryCheckoutAction = (uses: unknown): uses is string =>
  typeof uses === "string" &&
  REPOSITORY_CHECKOUT_ACTIONS.some((prefix) => uses.startsWith(prefix));
