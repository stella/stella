export const createSubmitIntent = (createKey: () => string) => {
  const keys = new Map<string, string>();
  return {
    request: (fingerprint = "") => {
      let key = keys.get(fingerprint);
      if (key === undefined) {
        key = createKey();
        keys.set(fingerprint, key);
      }
      return { headers: { "Idempotency-Key": key } };
    },
    complete: (completedKey: string) => {
      for (const [fingerprint, key] of keys) {
        if (key === completedKey) {
          keys.delete(fingerprint);
          return;
        }
      }
    },
    reset: () => keys.clear(),
  };
};
