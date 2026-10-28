import { AsyncLocalStorage } from "node:async_hooks";

// Workers share this state; request classification and HTTP errors live elsewhere.
const publicReadTimeout = new AsyncLocalStorage<{
  budgetMs: number;
  signal?: AbortSignal | undefined;
}>();

export const getPublicReadStatementTimeoutMs = () =>
  publicReadTimeout.getStore()?.budgetMs;

export const getPublicReadSignal = () => publicReadTimeout.getStore()?.signal;

type PublicReadTimeoutOptions = {
  budgetMs: number;
  signal?: AbortSignal | undefined;
};

export const runWithPublicReadStatementTimeout = <T>(
  { budgetMs, signal = getPublicReadSignal() }: PublicReadTimeoutOptions,
  fn: () => T,
): T => publicReadTimeout.run({ budgetMs, signal }, fn);
