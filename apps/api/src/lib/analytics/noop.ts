import type { Analytics } from "@/api/lib/analytics/types";

const noop = () => undefined;
const asyncNoop = async () => await Promise.resolve();

export const noopAnalytics: Analytics = {
  capture: noop,
  flush: asyncNoop,
};
