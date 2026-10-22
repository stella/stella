import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";

const WEB_ROOT = path.resolve(import.meta.dirname, "../..");
const MAX_BLANK_MS = 1000;
const OBSERVATION_MS = 3000;

test("a stale case-law search keeps content or offers recovery after a deploy", async ({
  page,
  request,
  browserErrors,
  baseURL,
}, testInfo) => {
  test.skip(
    EXPECTS_DEV_RUNTIME,
    "Requires the production served-build harness",
  );
  if (baseURL === undefined) {
    throw new Error("The existing E2E web origin must be configured");
  }

  // A private copy keeps asset removal from disrupting parallel browser tests.
  const temporary = await mkdtemp(path.join(tmpdir(), "stale-chunk-"));
  const dist = path.join(temporary, "dist");
  await cp(path.join(WEB_ROOT, "dist"), dist, { recursive: true });
  await symlink(
    path.join(WEB_ROOT, "node_modules"),
    path.join(temporary, "node_modules"),
    "dir",
  );
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (address === null || typeof address === "string") {
    throw new Error("The isolated production server needs a TCP port");
  }
  const origin = `http://localhost:${address.port}`;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  // Same built runtime and environment as setup-production-e2e/action.yml.
  const server = spawn("bun", [path.join(dist, "runtime.js")], {
    cwd: WEB_ROOT,
    env: { ...process.env, NODE_ENV: "production", PORT: String(address.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(server, "exit");
  const logs: string[] = [];
  server.stdout.on("data", (chunk) => {
    logs.push(String(chunk));
  });
  server.stderr.on("data", (chunk) => {
    logs.push(String(chunk));
  });

  try {
    await expect
      .poll(async () => {
        const response = await request
          .get(`${origin}/health`, { timeout: 1000 })
          // swallow-ok: Connection refusal is expected until the child binds its port.
          .catch(() => null);
        return response?.ok() ?? false;
      })
      .toBe(true);

    // Preserve the harness origin for seeded cookies and API CORS while the
    // real production runtime serves an isolated, deliberately damaged build.
    const webOrigin = new URL(baseURL).origin;
    await page.route(
      (url) => url.origin === webOrigin,
      async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({
          url: `${origin}${url.pathname}${url.search}`,
        });
        await route.fulfill({ response });
      },
    );

    await page.addInitScript(() => {
      localStorage.setItem(
        "stella-i18n",
        JSON.stringify({ state: { lang: "en" }, version: 0 }),
      );
      let blankSince: number | null = null;
      const sample = () => {
        if (sessionStorage.getItem("stale-chunk:armed") === "true") {
          sessionStorage.setItem(
            "stale-chunk:samples",
            String(
              Number(sessionStorage.getItem("stale-chunk:samples") ?? "0") + 1,
            ),
          );
          const recovery = document.querySelector(
            '[role="alert"][aria-labelledby="route-error-title"]',
          );
          const content =
            recovery ??
            document.querySelector('[data-slot="workspace-shell-content"]');
          const visible =
            content instanceof HTMLElement &&
            content.getBoundingClientRect().height > 0;
          const populated =
            visible &&
            (content.textContent.trim().length > 0 ||
              content.querySelector('[data-slot="skeleton"]') !== null);
          const now = performance.now();
          if (populated) {
            blankSince = null;
          } else {
            blankSince ??= now;
            const maximum = Number(
              sessionStorage.getItem("stale-chunk:max-blank") ?? "0",
            );
            sessionStorage.setItem(
              "stale-chunk:max-blank",
              String(Math.max(maximum, now - blankSince)),
            );
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    // The entry box is interactive before the results route has been loaded.
    // Opening /law/cases first would cache its chunk and miss the fault entirely.
    await page.goto("/law?country=cze", {
      waitUntil: "domcontentloaded",
    });
    const input = page.getByRole("search").getByRole("textbox");
    await expect(input).toBeEditable();
    await expect(
      page.locator('[data-slot="sidebar"] a[href^="/workspaces"]'),
    ).not.toHaveCount(0);

    const assets = path.join(dist, "client/assets");
    const chunks = (await readdir(assets)).filter((file) =>
      /^-case-law-index-page-.+\.js$/u.test(file),
    );
    expect(
      chunks,
      "The build must contain the lazy case-law results page",
    ).not.toHaveLength(0);
    const removedPaths = new Set(chunks.map((file) => `/assets/${file}`));
    const missing: string[] = [];
    page.on("response", (response) => {
      if (
        removedPaths.has(new URL(response.url()).pathname) &&
        response.status() === 404
      ) {
        missing.push(response.url());
      }
    });
    for (const file of chunks) {
      await rename(
        path.join(assets, file),
        path.join(assets, `${file}.removed`),
      );
    }
    await page.evaluate(() =>
      sessionStorage.setItem("stale-chunk:armed", "true"),
    );
    // These errors are the injected failure, not unrelated browser faults.
    browserErrors.expectCaptured(
      /(?:404|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)/u,
    );
    await input.fill("fiktivní");
    await input.press("Enter");
    await expect
      .poll(() => missing.length, {
        message: "Search must actually request the removed chunk",
      })
      .toBeGreaterThan(0);
    // Keep the file absent across automatic reload: the cooldown must expose
    // recovery instead of looping or depending on a lucky second asset fetch.
    const recovery = page
      .getByRole("alert")
      .filter({ has: page.locator("#route-error-title") });
    await expect(
      recovery.getByRole("button", { name: "Try again", exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () => {
          const elapsed = await page.evaluate(() => {
            const start = Number(
              sessionStorage.getItem("stale-chunk:observation-start") ?? "0",
            );
            if (start === 0) {
              sessionStorage.setItem(
                "stale-chunk:observation-start",
                String(Date.now()),
              );
              return 0;
            }
            return Date.now() - start;
          });
          return elapsed;
        },
        { timeout: OBSERVATION_MS + 3000 },
      )
      .toBeGreaterThanOrEqual(OBSERVATION_MS);
    const maximumBlank = await page.evaluate(() =>
      Number(sessionStorage.getItem("stale-chunk:max-blank") ?? "0"),
    );
    expect(
      await page.evaluate(() =>
        Number(sessionStorage.getItem("stale-chunk:samples") ?? "0"),
      ),
    ).toBeGreaterThan(1);
    expect(
      maximumBlank,
      `Content may never remain blank for ${MAX_BLANK_MS}ms`,
    ).toBeLessThan(MAX_BLANK_MS);
    await expect(
      recovery.getByRole("button", { name: "Try again", exact: true }),
    ).toBeVisible();
    await testInfo.attach("deploy-evidence", {
      body: JSON.stringify({ missing, maximumBlank, boundMs: MAX_BLANK_MS }),
      contentType: "application/json",
    });
  } finally {
    server.kill("SIGTERM");
    await exited;
    await testInfo.attach("production-runtime", {
      body: logs.join(""),
      contentType: "text/plain",
    });
    await rm(temporary, { recursive: true, force: true });
  }
});
