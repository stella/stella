type Entry = { otp: string; ts: number };

const store = new Map<string, Entry>();
const TTL_MS = 5 * 60_000;

export const stashDevOtp = (email: string, otp: string): void => {
  store.set(email, { otp, ts: Date.now() });
};

export const popDevOtp = (email: string): string | null => {
  const entry = store.get(email);
  if (!entry) {
    return null;
  }
  store.delete(email);
  if (Date.now() - entry.ts > TTL_MS) {
    return null;
  }
  return entry.otp;
};
