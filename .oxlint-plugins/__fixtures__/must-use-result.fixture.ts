// Passive regression fixture for `must-use-result/must-use-result`.

declare const callback: () => unknown;
declare const consume: (value: unknown) => void;
declare const safeDb: (operation: () => unknown) => unknown;
declare const Result: {
  gen: (operation: () => unknown) => unknown;
};

export const discardSafeDb = () => {
  // MUST flag: a bare Result-producing statement silently drops failures.
  // oxlint-disable-next-line must-use-result/must-use-result -- fixture: safeDb results must be consumed
  safeDb(callback);
};

export const discardResultNamespaceCall = () => {
  // MUST flag: known Result namespace constructors are protected too.
  // oxlint-disable-next-line must-use-result/must-use-result -- fixture: Result.gen results must be consumed
  Result.gen(callback);
};

// Allowed: assignment structurally consumes the Result value.
export const assignedResult = safeDb(callback);

// Allowed: passing the Result to another function consumes it.
export const passedResult = () => consume(safeDb(callback));

// Allowed: callers may return the Result to their own caller.
export const returnedResult = () => safeDb(callback);
