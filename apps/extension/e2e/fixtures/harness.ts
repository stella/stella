import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  type Worker,
} from "@playwright/test";
import { panic } from "better-result";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlCommand,
  type BrowserControlElement,
  type BrowserControlResult,
  type BrowserObservedTab,
  parseBrowserControlResult,
} from "@stll/api-contract/browser-control";

// The e2e build is the only one that trusts the loopback stella page.
export const builtExtensionPath = path.join(
  import.meta.dirname,
  "../../.output/chrome-mv3-e2e",
);

export const listen = async (server: Server): Promise<number> =>
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        panic("Test server did not bind a TCP port");
      }
      resolve(address.port);
    });
  });

export const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

/**
 * The shipped build keeps website access and the downloads API optional,
 * which needs a native prompt no test can accept. The spec loads a copy
 * whose manifest grants both at install. It also grants the loopback stella
 * page, standing in for the `activeTab` grant a real popup click gives, so
 * the worker can read that tab's URL when pairing; nothing else differs from
 * the built output.
 */
export const prepareGrantedExtension = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-extension-granted-"),
  );
  await cp(builtExtensionPath, directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf-8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("permissions" in manifest) ||
    !Array.isArray(manifest.permissions)
  ) {
    return panic("Built manifest has no permission list");
  }
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      host_permissions: ["https://*/*", "http://127.0.0.1/*"],
      permissions: [
        ...manifest.permissions.filter(
          (permission): permission is string => typeof permission === "string",
        ),
        "downloads",
      ],
    }),
  );
  return directory;
};

export const STELLA_PAGE = `<!doctype html><html><head><title>stella test</title></head><body>
<script>
window.__responses = {};
window.__pongs = [];
window.addEventListener("message", ({ data }) => {
  if (data && data.source === "${BROWSER_EXTENSION_MESSAGE_SOURCE.extension}" && typeof data.requestId === "string") {
    window.__responses[data.requestId] = data;
    if (data.type === "pong") {
      window.__pongs.push(data);
    }
  }
});
</script></body></html>`;

type ExtensionHarness = {
  context: BrowserContext;
  /** Where downloads land once a test hands them back to Chrome. */
  downloadPath: string;
  /** Pairs the stella page as the controller, as the popup would. */
  pair: (controllerId: string) => Promise<void>;
  stella: Page;
  stellaOrigin: string;
  worker: Worker;
  close: () => Promise<void>;
};

/**
 * Launches Chromium with the granted extension and a loopback stella page
 * that records every extension message it receives.
 */
export const launchExtensionHarness = async ({
  serveLoopback,
}: {
  serveLoopback?: (url: string) => string | undefined;
} = {}): Promise<ExtensionHarness> => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(serveLoopback?.(request.url ?? "/") ?? STELLA_PAGE);
  });
  const port = await listen(server);
  const stellaOrigin = `http://127.0.0.1:${port}`;
  const extensionPath = await prepareGrantedExtension();
  const profilePath = await mkdtemp(
    path.join(tmpdir(), "stella-extension-harness-"),
  );
  const downloadPath = await mkdtemp(
    path.join(tmpdir(), "stella-extension-downloads-"),
  );
  const context = await chromium.launchPersistentContext(profilePath, {
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    channel: "chromium",
    headless: true,
  });
  const close = async () => {
    await context.close();
    await closeServer(server);
    await rm(profilePath, { force: true, recursive: true });
    await rm(downloadPath, { force: true, recursive: true });
    await rm(extensionPath, { force: true, recursive: true });
  };

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

  return {
    close,
    context,
    downloadPath,
    async pair(controllerId) {
      await stella.bringToFront();
      const paired = await worker.evaluate(
        async ({ id, origin }) => {
          const tab = (
            await chrome.tabs.query({ active: true, currentWindow: true })
          ).at(0);
          if (tab?.id === undefined) {
            return false;
          }
          await chrome.storage.session.set({
            browserController: { controllerId: id, origin, tabId: tab.id },
          });
          return true;
        },
        { id: controllerId, origin: stellaOrigin },
      );
      if (!paired) {
        panic("Could not find the stella test tab");
      }
    },
    stella,
    stellaOrigin,
    worker,
  };
};

const waitForResponse = async (
  stella: Page,
  requestId: string,
): Promise<unknown> => {
  const handle = await stella.waitForFunction(
    (id): unknown => {
      const responses: unknown = Reflect.get(window, "__responses");
      return typeof responses === "object" && responses !== null
        ? Reflect.get(responses, id)
        : undefined;
    },
    requestId,
    { timeout: 60_000 },
  );
  const response: unknown = await handle.jsonValue();
  return response;
};

type SendOptions = {
  /** Replays an earlier tool call's id. */
  toolCallId?: string;
  turnId?: string;
};

/**
 * Posts commands the way the web bridge does: each envelope carries the tab
 * and snapshot of the last successful result, and the chat turn.
 */
export const createCommandSender = (stella: Page, controllerId: string) => {
  let sequence = 0;
  let observedTab: BrowserObservedTab | null = null;

  const post = async (
    command: BrowserControlCommand,
    { toolCallId, turnId = "turn-1" }: SendOptions = {},
  ): Promise<string> => {
    sequence += 1;
    const requestId = `request-${sequence}`;
    await stella.evaluate(
      (request) => {
        window.postMessage(request, window.location.origin);
      },
      {
        command,
        controllerId,
        observedTab,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        requestId,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
        toolCallId: toolCallId ?? `tool-${sequence}`,
        turnId,
        type: "command",
      },
    );
    return requestId;
  };

  const result = async (requestId: string): Promise<BrowserControlResult> => {
    const response = await waitForResponse(stella, requestId);
    const parsed =
      typeof response === "object" && response !== null && "result" in response
        ? parseBrowserControlResult(response.result)
        : null;
    if (!parsed) {
      return panic(`Malformed command result for ${requestId}`);
    }
    if (parsed.status === "success") {
      observedTab = {
        revision: parsed.snapshot.revision,
        tabId: parsed.snapshot.tabId,
      };
    }
    return parsed;
  };

  return {
    async cancel(): Promise<void> {
      sequence += 1;
      await stella.evaluate(
        (request) => {
          window.postMessage(request, window.location.origin);
        },
        {
          controllerId,
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          requestId: `cancel-${sequence}`,
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.web,
          type: "cancel",
        },
      );
    },
    post,
    result,
    async send(
      command: BrowserControlCommand,
      options?: SendOptions,
    ): Promise<BrowserControlResult> {
      return await result(await post(command, options));
    },
  };
};

export const successful = (result: BrowserControlResult) => {
  expect(result.status, JSON.stringify(result)).toBe("success");
  if (result.status !== "success") {
    return panic("unreachable");
  }
  return result.snapshot;
};

export const elementNamed = (
  elements: readonly BrowserControlElement[],
  name: string,
): BrowserControlElement => {
  const element = elements.find((candidate) => candidate.name === name);
  if (!element) {
    return panic(`No element named ${name}`);
  }
  return element;
};

export const targetOf = ({
  context,
  href,
  name,
  ref,
  role,
}: BrowserControlElement) => ({
  name,
  ref,
  role,
  ...(context === undefined ? {} : { context }),
  ...(href === undefined ? {} : { href }),
});
