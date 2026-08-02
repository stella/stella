type Entry = { otp: string; ts: number };

const store = new Map<string, Entry>();
const TTL_MS = 5 * 60_000;

export const stashDevOtp = (email: string, otp: string): void => {
  const entry = { otp, ts: Date.now() };
  store.set(email, entry);

  const expiryTimer = setTimeout(() => {
    if (store.get(email) === entry) {
      store.delete(email);
    }
  }, TTL_MS);
  expiryTimer.unref();
};

export const readDevOtp = (email: string): string | null => {
  const entry = store.get(email);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts >= TTL_MS) {
    store.delete(email);
    return null;
  }
  return entry.otp;
};
