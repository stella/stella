import type { Page } from "@playwright/test";
import { panic } from "better-result";
import { readFileSync } from "node:fs";

import { sha256Base64 } from "@stll/sha256/node";

/**
 * Serves a window under the Content Security Policy the desktop ships, so a
 * spec sees what the webview would refuse.
 *
 * The policy is read from `tauri.conf.json`, never restated here. One thing
 * is added, as Tauri adds it: Tauri puts a hash of every inline script of the
 * page it serves into `script-src`, and the dev server's page has one (the
 * React refresh preamble). Nothing else is loosened.
 */

const readShippedPolicy = (): string => {
  const config: unknown = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf-8",
    ),
  );
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null
      ? (Object.getOwnPropertyDescriptor(value, key)?.value as unknown)
      : undefined;
  const csp = field(field(field(config, "app"), "security"), "csp");
  if (typeof csp !== "string" || !csp.includes("script-src 'self'")) {
    panic("tauri.conf.json ships no script-src 'self' policy");
  }
  return csp;
};

const SHIPPED_POLICY = readShippedPolicy();

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gu;

const VIOLATIONS_GLOBAL = "__DESKTOP_CSP_VIOLATIONS__";

/** Applies the shipped policy to the page's documents and records every
 *  violation the browser reports. Call before `page.goto`. */
export const enforceDesktopCsp = async (page: Page) => {
  await page.route(
    (url) => url.pathname === "/" || url.pathname.endsWith(".html"),
    async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      const hashes = [...html.matchAll(INLINE_SCRIPT)].map(
        ([, body = ""]) => `'sha256-${sha256Base64(body)}'`,
      );
      await route.fulfill({
        response,
        body: html,
        headers: {
          ...response.headers(),
          "content-security-policy": SHIPPED_POLICY.replace(
            "script-src 'self'",
            () => ["script-src 'self'", ...hashes].join(" "),
          ),
        },
      });
    },
  );
  await page.addInitScript((global) => {
    const seen: string[] = [];
    Reflect.set(window, global, seen);
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  }, VIOLATIONS_GLOBAL);
};

/** The violations the page reported so far, as `directive blocked-uri`. */
export const desktopCspViolations = async (page: Page): Promise<string[]> => {
  const seen = await page.evaluate(
    (global): unknown => Reflect.get(window, global),
    VIOLATIONS_GLOBAL,
  );
  if (
    !Array.isArray(seen) ||
    !seen.every((entry) => typeof entry === "string")
  ) {
    panic("The CSP violation log is not installed");
  }
  return seen;
};
