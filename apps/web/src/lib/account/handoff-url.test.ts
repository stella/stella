import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

import {
  handoffNavigationDestination,
  sanitizeHandoffUrl,
} from "@/lib/account/handoff-url";

const capture = async (href: string) => {
  const location = new URL(href);
  let clean = href;
  const window = {
    location,
    takeStellaHandoff: ():
      { code: string; path: string; destination: string } | undefined =>
      undefined,
    history: {
      state: { preserved: true },
      replaceState: (_state: unknown, _title: string, url: URL) => {
        clean = url.href;
      },
    },
  };
  const source = await Bun.file(
    new URL("../../../public/handoff-init.js", import.meta.url),
  ).text();
  runInNewContext(source, { window, URL, URLSearchParams });
  return { window, clean };
};

describe("handoff URL handling", () => {
  test("captures once while removing all handoff fragment parameters before application startup", async () => {
    for (const path of ["/workspaces/matter", "/law/cz/statutes/example"]) {
      const { window, clean } = await capture(
        `https://example.test${path}?tab=notes#sh=sh1_sample&anchor=article&sh=second`,
      );
      expect(clean).toBe(
        `https://example.test${path}?tab=notes#anchor=article`,
      );
      expect(window.takeStellaHandoff()).toEqual({
        code: "sh1_sample",
        path: `${path}?tab=notes`,
        destination: `${path}?tab=notes#anchor=article`,
      });
      expect(window.takeStellaHandoff()).toBeUndefined();
      expect(window.history.state).toEqual({ preserved: true });
    }
  });

  test("ordinary anchors remain unchanged and empty handoffs are stripped", async () => {
    expect((await capture("https://example.test/law#article-3")).clean).toBe(
      "https://example.test/law#article-3",
    );
    const { window, clean } = await capture("https://example.test/law#sh=");
    expect(clean).toBe("https://example.test/law");
    expect(window.takeStellaHandoff()).toBeUndefined();
  });

  test("telemetry URL sanitization removes query and fragment handoffs and is idempotent", () => {
    for (const url of [
      "https://example.test/path?sh=sh1_sample&tab=notes#sh=sh1_sample&anchor=article",
      "https://example.test/path#%73h=sh1_sample&sh=second",
    ]) {
      const clean = sanitizeHandoffUrl(url);
      expect(clean).not.toContain("sh1_sample");
      expect(clean).not.toContain("second");
      expect(sanitizeHandoffUrl(clean)).toBe(clean);
    }
  });
});

test("handoff refusal keeps public law readable and protected destinations available after sign-in", () => {
  const publicPath = "/law/cze/statutes/example?version=1#section=2";
  const protectedPath = "/workspaces/matter?tab=notes#section=2";
  expect(handoffNavigationDestination(publicPath, "refused")).toBe(publicPath);
  expect(handoffNavigationDestination(protectedPath, "refused")).toBe(
    `/auth?redirectTo=${encodeURIComponent(protectedPath)}`,
  );
  expect(handoffNavigationDestination(protectedPath, "redeemed")).toBe(
    protectedPath,
  );
  expect(handoffNavigationDestination("//example.test", "redeemed")).toBe("/");
});

test("handoff capture preserves reader anchors exactly", async () => {
  for (const anchor of [
    "section-2",
    "section=2",
    "paragraph%202",
    "article=3&paragraph=2",
  ]) {
    const { window, clean } = await capture(
      `https://example.test/law#${anchor}&sh=sh1_sample`,
    );
    expect(clean).toBe(`https://example.test/law#${anchor}`);
    expect(window.takeStellaHandoff()?.destination).toBe(`/law#${anchor}`);
  }
});
