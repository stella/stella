import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { rewriteWorkspaceUrlsToMentions } from "@/api/lib/chat/workspace-url-mentions";

const WS = "7a7c5299-15e2-45da-8190-0adfbb85184b";
const VIEW = "019df710-7718-7001-b7a5-2ce9a7c9117e";
const BASE = "https://my.stll.app";

describe("rewriteWorkspaceUrlsToMentions", () => {
  test("rewrites a pasted matter link into a workspace mention", () => {
    const refRegistry = createChatRefRegistry();
    const rewritten = rewriteWorkspaceUrlsToMentions({
      appBaseUrl: BASE,
      refRegistry,
      text: `list things in ${BASE}/workspaces/${WS} please`,
    });
    const matterRef = refRegistry.toMatterRef(toSafeId<"workspace">(WS));
    expect(rewritten).toBe(
      `list things in [matter](#stella-workspace-ref=${matterRef}) please`,
    );
    expect(rewritten).not.toContain(WS);
  });

  test("consumes deeper path segments (view ids) into the same mention", () => {
    const refRegistry = createChatRefRegistry();
    const rewritten = rewriteWorkspaceUrlsToMentions({
      appBaseUrl: BASE,
      refRegistry,
      text: `${BASE}/workspaces/${WS}/${VIEW}`,
    });
    expect(rewritten).toBe("[matter](#stella-workspace-ref=mat_1)");
    expect(rewritten).not.toContain(VIEW);
  });

  test("reuses one ref for repeated links and leaves foreign URLs alone", () => {
    const refRegistry = createChatRefRegistry();
    const rewritten = rewriteWorkspaceUrlsToMentions({
      appBaseUrl: BASE,
      refRegistry,
      text:
        `${BASE}/workspaces/${WS} and again ${BASE}/workspaces/${WS} ` +
        `but not https://example.test/workspaces/${WS}`,
    });
    expect(rewritten).toBe(
      "[matter](#stella-workspace-ref=mat_1) and again " +
        "[matter](#stella-workspace-ref=mat_1) " +
        `but not https://example.test/workspaces/${WS}`,
    );
  });

  test("text without workspace links passes through untouched", () => {
    const refRegistry = createChatRefRegistry();
    const text = "no links here, just words";
    expect(
      rewriteWorkspaceUrlsToMentions({ appBaseUrl: BASE, refRegistry, text }),
    ).toBe(text);
  });
});
