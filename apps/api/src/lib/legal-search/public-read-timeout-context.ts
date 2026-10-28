import { panic } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

type PublicReadWork = {
  pending: Set<Promise<void>>;
  status: "active" | "settling" | "settled";
};

// Workers share this state; request classification and HTTP errors live elsewhere.
const publicReadTimeout = new AsyncLocalStorage<{
  budgetMs: number;
  signal?: AbortSignal | undefined;
  work?: PublicReadWork | undefined;
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
): T =>
  publicReadTimeout.run(
    { budgetMs, signal, work: publicReadTimeout.getStore()?.work },
    fn,
  );

/** Own every started transaction even if a parallel caller rejects early. */
export const runWithPublicReadScope = async <T>(
  { budgetMs, signal }: PublicReadTimeoutOptions,
  fn: () => Promise<T>,
): Promise<T> => {
  const work: PublicReadWork = { pending: new Set(), status: "active" };
  return await publicReadTimeout.run({ budgetMs, signal, work }, async () => {
    try {
      return await fn();
    } finally {
      work.status = "settling";
      while (work.pending.size > 0) {
        await Promise.allSettled(work.pending);
      }
      work.status = "settled";
    }
  });
};

/** The public transaction owner registers before acquisition and finishes after cleanup. */
export const beginPublicRead = () => {
  const work = publicReadTimeout.getStore()?.work;
  if (work === undefined) {
    return () => undefined;
  }
  if (work.status === "settled") {
    return panic("Public read started after its admission scope settled");
  }
  const completed = Promise.withResolvers<undefined>();
  work.pending.add(completed.promise);
  return () => {
    work.pending.delete(completed.promise);
    completed.resolve(undefined);
  };
};
