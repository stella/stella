import { Temporal } from "@stll/time";

export const accountExpiryDelay = (expiresAt: string, now: number) =>
  Math.max(0, Temporal.Instant.from(expiresAt).epochMilliseconds - now);
