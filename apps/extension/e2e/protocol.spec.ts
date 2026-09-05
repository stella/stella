import { chromium, expect, test, type Page } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlCommand,
  type BrowserControlElement,
  type BrowserControlResult,
  parseBrowserControlResult,
} from "@stll/api-contract/browser-control";

import { FIXTURE_ORIGIN, FIXTURE_PAGES } from "./fixtures/pages";

const builtExtensionPath = path.join(
  import.meta.dirname,
  "../.output/chrome-mv3",
);
const CONTROLLER_ID = "controller-protocol";

const listen = async (server: Server): Promise<number> =>
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new TypeError("Test server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });

/**
 * The shipped build keeps the website grant optional, which needs a native
 * prompt no test can accept. The spec loads a copy whose manifest grants every
 * HTTPS host at install; nothing else differs from the built output.
 */
const prepareGrantedExtension = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-extension-granted-"),
  );
  await cp(builtExtensionPath, directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest !== "object" || manifest === null) {
    throw new TypeError("Built manifest is not an object");
  }
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, host_permissions: ["https://*/*"] }),
  );
  return directory;
};

const STELLA_PAGE = `<!doctype html><html><head><title>stella test</title></head><body>
<script>
window.__responses = {};
window.addEventListener("message", ({ data }) => {
  if (data && data.source === "${BROWSER_EXTENSION_MESSAGE_SOURCE.extension}" && typeof data.requestId === "string") {
    window.__responses[data.requestId] = data;
  }
});
</script></body></html>`;

const createCommandSender = (stella: Page) => {
  let sequence = 0;
  return async (
    command: BrowserControlCommand,
    toolCallId?: string,
  ): Promise<BrowserControlResult> => {
    sequence += 1;
    const requestId = `request-${sequence}`;
    await stella.evaluate(
      ({
        command,
        controllerId,
        protocolVersion,
        requestId,
        source,
        toolCallId,
      }) => {
        window.postMessage(
          {
            command,
            controllerId,
            protocolVersion,
            requestId,
            source,
            toolCallId,
            type: "command",
          },
          window.location.origin,
        );
      },
      {
        command,
        controllerId: CONTROLLER_ID,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
        toolCallId: toolCallId ?? `tool-${sequence}`,
      },
    );
    const handle = await stella.waitForFunction(
      (id) => {
        const responses: unknown = Reflect.get(window, "__responses");
        return typeof responses === "object" && responses !== null
          ? Reflect.get(responses, id)
          : undefined;
      },
      requestId,
      { timeout: 60_000 },
    );
    const response: unknown = await handle.jsonValue();
    const result =
      typeof response === "object" && response !== null && "result" in response
        ? parseBrowserControlResult(response.result)
        : null;
    if (!result) {
      throw new TypeError(`Malformed command result for ${requestId}`);
    }
    return result;
  };
};

const successful = (result: BrowserControlResult) => {
  expect(result.status, JSON.stringify(result)).toBe("success");
  if (result.status !== "success") {
    throw new TypeError("unreachable");
  }
  return result.snapshot;
};

const elementNamed = (
  elements: readonly BrowserControlElement[],
  name: string,
): BrowserControlElement => {
  const element = elements.find((candidate) => candidate.name === name);
  if (!element) {
    throw new TypeError(`No element named ${name}`);
  }
  return element;
};

const targetOf = ({ href, name, ref, role }: BrowserControlElement) => ({
  name,
  ref,
  role,
  ...(href === undefined ? {} : { href }),
});

test("reads frames and shadow roots, pages text, and enforces the origin policy", async () => {
  test.setTimeout(180_000);
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      request.url?.startsWith("/plain")
        ? "<!doctype html><html><body><p>Plain HTTP page.</p></body></html>"
        : STELLA_PAGE,
    );
  });
  const port = await listen(server);
  const stellaOrigin = `http://127.0.0.1:${port}`;
  const extensionPath = await prepareGrantedExtension();
  const profilePath = await mkdtemp(
    path.join(tmpdir(), "stella-extension-protocol-"),
  );
  const context = await chromium.launchPersistentContext(profilePath, {
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    channel: "chromium",
    headless: true,
  });
  await context.route(`${FIXTURE_ORIGIN}/**`, async (route) => {
    const body = FIXTURE_PAGES[new URL(route.request().url()).pathname];
    await (body === undefined
      ? route.fulfill({ body: "not found", status: 404 })
      : route.fulfill({
          body,
          contentType: "text/html; charset=utf-8",
          status: 200,
        }));
  });

  try {
    const stella = await context.newPage();
    await stella.goto(`${stellaOrigin}/chat`);
    await stella.waitForFunction(() => {
      const responses: unknown = Reflect.get(window, "__responses");
      return (
        typeof responses === "object" &&
        responses !== null &&
        "extension-ready" in responses
      );
    });
    const worker =
      context.serviceWorkers().at(0) ??
      (await context.waitForEvent("serviceworker"));
    await stella.bringToFront();
    await worker.evaluate(
      async ({ controllerId, origin }) => {
        const tab = (
          await chrome.tabs.query({ active: true, currentWindow: true })
        ).at(0);
        if (tab?.id === undefined) {
          throw new TypeError("Could not find the stella test tab");
        }
        await chrome.storage.session.set({
          browserController: { controllerId, origin, tabId: tab.id },
        });
      },
      { controllerId: CONTROLLER_ID, origin: stellaOrigin },
    );
    const send = createCommandSender(stella);

    for (const url of [
      `${stellaOrigin}/plain`,
      "https://192.168.1.1/admin",
      "https://localhost/",
      "https://user:pw@example.com/",
      "https://printer.local/",
    ]) {
      expect(await send({ action: "open", url })).toMatchObject({
        code: BROWSER_CONTROL_ERROR_CODE.navigationFailed,
      });
    }

    // The extension creates the controlled tab itself, so route interception
    // attaches only after its first navigation; that first load fails on DNS
    // and the second reaches the fixture through the now-attached tab.
    const indexUrl = `${FIXTURE_ORIGIN}/index.html`;
    let opened = await send({ action: "open", url: indexUrl });
    if (opened.status !== "success") {
      opened = await send({ action: "open", url: indexUrl });
    }
    let snapshot = successful(opened);
    expect(snapshot.url).toBe(indexUrl);
    expect(snapshot.text).toHaveLength(BROWSER_CONTROL_LIMITS.pageTextChars);
    expect(snapshot.textTotalChars).toBeGreaterThan(
      BROWSER_CONTROL_LIMITS.pageTextChars,
    );
    expect(snapshot.text).toContain("Visible through display contents");
    expect(snapshot.text).toContain("Shadow text inside the widget");
    expect(elementNamed(snapshot.elements, "Frame action").ref).toMatch(
      /^e:[1-9]\d*:/u,
    );
    expect(elementNamed(snapshot.elements, "Shadow action").ref).toContain(
      ".s.",
    );
    expect(elementNamed(snapshot.elements, "External decision 42").href).toBe(
      "https://example.com/decision/42",
    );
    expect(elementNamed(snapshot.elements, "Password field").value).toBe(
      undefined,
    );

    const lastOffset = snapshot.textTotalChars - 1;
    const tail = successful(
      await send({ action: "snapshot", textOffset: lastOffset }),
    );
    expect(tail.textOffset).toBe(lastOffset);
    expect(tail.text).toHaveLength(1);
    const remainder = successful(
      await send({
        action: "snapshot",
        textOffset: BROWSER_CONTROL_LIMITS.pageTextChars * 2,
      }),
    );
    expect(remainder.text).toContain("Frame text lives here");
    snapshot = remainder;

    const page = () => ({ revision: snapshot.revision, url: snapshot.url });
    expect(
      await send({
        action: "click",
        page: { revision: "stale", url: snapshot.url },
        target: targetOf(elementNamed(snapshot.elements, "Second page")),
      }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot });
    expect(
      await send({
        action: "click",
        page: page(),
        target: {
          ...targetOf(elementNamed(snapshot.elements, "Second page")),
          href: `${FIXTURE_ORIGIN}/other.html`,
        },
      }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot });
    expect(
      await send({
        action: "fill",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Password field")),
        value: "secret",
      }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.sensitiveField });

    snapshot = successful(
      await send({
        action: "fill",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Search query")),
        value: "notice period",
      }),
    );
    expect(elementNamed(snapshot.elements, "Search query").value).toBe(
      "notice period",
    );
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Run search")),
      }),
    );
    expect(snapshot.text).toContain("Submitted: notice period");
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Shadow action")),
      }),
    );
    expect(
      snapshot.elements.some(({ name }) => name === "Shadow clicked"),
    ).toBe(true);
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Frame action")),
      }),
    );
    expect(snapshot.elements.some(({ name }) => name === "Frame clicked")).toBe(
      true,
    );

    const replayId = "tool-replay";
    const navigated = successful(
      await send(
        {
          action: "click",
          page: page(),
          target: targetOf(elementNamed(snapshot.elements, "Second page")),
        },
        replayId,
      ),
    );
    expect(navigated.url).toBe(`${FIXTURE_ORIGIN}/page2.html`);
    const replayed = successful(
      await send(
        {
          action: "click",
          page: page(),
          target: targetOf(elementNamed(snapshot.elements, "Second page")),
        },
        replayId,
      ),
    );
    expect(replayed.revision).toBe(navigated.revision);
    expect(await send({ action: "snapshot" }, replayId)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.invalidCommand,
    });

    snapshot = successful(await send({ action: "go-back" }));
    expect(snapshot.url).toBe(indexUrl);

    const controlled = context
      .pages()
      .find((candidate) => candidate.url().startsWith(FIXTURE_ORIGIN));
    if (!controlled) {
      throw new TypeError("Controlled tab not found");
    }
    await controlled.goto(`${stellaOrigin}/plain`);
    expect(await send({ action: "snapshot" })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
    });
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(
            new Error("Could not close the extension test server", {
              cause: error,
            }),
          );
          return;
        }
        resolve();
      });
    });
    await rm(profilePath, { force: true, recursive: true });
    await rm(extensionPath, { force: true, recursive: true });
  }
});
