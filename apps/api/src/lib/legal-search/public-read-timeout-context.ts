import { AsyncLocalStorage } from "node:async_hooks";

// Workers share this state; request classification and HTTP errors live elsewhere.
const publicReadTimeout = new AsyncLocalStorage<number>();

export const getPublicReadStatementTimeoutMs = () =>
  publicReadTimeout.getStore();

export const runWithPublicReadStatementTimeout = <T>(
  budgetMs: number,
  fn: () => T,
): T => publicReadTimeout.run(budgetMs, fn);
