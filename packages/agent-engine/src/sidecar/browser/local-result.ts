import type { BrowserControlResult } from "@stll/api-contract/browser-control";

const LOCAL_ONLY: unique symbol = Symbol("stella.local-browser-result");

/**
 * A result from the member's Chrome: page content that stays on this
 * computer. The bridge is the only producer. The content sits under a
 * module-private symbol, so it is not a `BrowserControlResult` anywhere it
 * could be passed by mistake, and serialising it (`JSON.stringify`, which
 * every path to stella's servers goes through) writes `{}`. Only the MCP
 * answer to the agent on this computer reads it.
 */
export type LocalBrowserResult = {
  readonly [LOCAL_ONLY]: BrowserControlResult;
};

export const localBrowserResult = (
  result: BrowserControlResult,
): LocalBrowserResult => ({ [LOCAL_ONLY]: result });

export const readLocalBrowserResult = (
  local: LocalBrowserResult,
): BrowserControlResult => local[LOCAL_ONLY];
