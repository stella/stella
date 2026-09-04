// Passive regression fixture for `confine-owner/confine-owner`.
//
// This file appears in no ownership entry's `allowed` list, so every use of an
// owned capability here must be rejected. Each `oxlint-disable-next-line`
// suppresses a case the rule MUST flag: if the rule regresses, the directive
// goes unused and `--report-unused-disable-directives-severity=error` fails.

// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a static import of an owned module is rejected
import { createRedisClient } from "@/api/lib/redis-client";
// oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a type-only import still opens the owned surface and is rejected
import type { createBullMqConnection } from "@/api/lib/redis-client";

declare const navigator: {
  clipboard: { writeText: (text: string) => Promise<void> };
};
declare const window: {
  navigator: { clipboard: { writeText: (text: string) => Promise<void> } };
};

const loadConnection = async () =>
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a dynamic import of an owned module is rejected
  await import("@/api/lib/redis-client");

export const copyDirectly = async (text: string) => {
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves a direct clipboard write is rejected
  await navigator.clipboard.writeText(text);
};

export const copyThroughWindow = async (text: string) => {
  // oxlint-disable-next-line confine-owner/confine-owner -- fixture proves the `window.` spelling of the global is rejected
  await window.navigator.clipboard.writeText(text);
};

// Accepted: an unrelated member access that shares neither half of the pair.
export const readTitle = (page: { clipboard: string }) => page.clipboard;

void loadConnection;
void createRedisClient;
type _Connection = typeof createBullMqConnection;
