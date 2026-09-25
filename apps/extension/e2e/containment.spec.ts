import { expect, type Page, test } from "@playwright/test";

import { BROWSER_CONTROL_ERROR_CODE } from "@stll/api-contract/browser-control";

import {
  createCommandSender,
  elementNamed,
  launchExtensionHarness,
  successful,
  targetOf,
} from "./fixtures/harness";
import {
  FIXTURE_ORIGIN,
  FIXTURE_PAGES,
  HIDDEN_TEXT_MARKER,
  INTRANET_ORIGIN,
  INTRANET_PAGE,
  TOGGLED_SECRET,
} from "./fixtures/pages";

const CONTROLLER_ID = "controller-containment";
const SLOW_RESPONSE_MS = 20_000;

type Harness = Awaited<ReturnType<typeof launchExtensionHarness>>;

/** Serves the fixtures, a never-quick page and a binary, and records intranet traffic. */
const routeFixtures = async ({ context }: Harness) => {
  const intranetRequests: string[] = [];
  const serve = async (
    route: Parameters<Parameters<typeof context.route>[1]>[0],
  ) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/slow.html") {
      await new Promise((resolve) => {
        setTimeout(resolve, SLOW_RESPONSE_MS);
      });
      await route
        .fulfill({ body: "<p>Slow page</p>", contentType: "text/html" })
        .catch(() => undefined);
      return;
    }
    if (pathname === "/file.bin") {
      await route.fulfill({
        // Large enough that writing it outlasts the cancel.
        body: "binary payload ".repeat(400_000),
        contentType: "application/octet-stream",
      });
      return;
    }
    const body = FIXTURE_PAGES[pathname];
    await (body === undefined
      ? route.fulfill({ body: "not found", status: 404 })
      : route.fulfill({
          body,
          contentType: "text/html; charset=utf-8",
        }));
  };
  await context.route(`${FIXTURE_ORIGIN}/**`, serve);
  await context.route(`${INTRANET_ORIGIN}/**`, async (route) => {
    intranetRequests.push(route.request().url());
    await route.fulfill({
      body: INTRANET_PAGE,
      contentType: "text/html; charset=utf-8",
    });
  });
  return intranetRequests;
};

/** An extension page, the context the popup's requests come from. */
const openExtensionPage = async ({ context, worker }: Harness) => {
  const page = await context.newPage();
  await page.goto(new URL("/popup.html", worker.url()).href);
  return {
    page,
    async request(request: Record<string, unknown>): Promise<unknown> {
      return await page.evaluate(
        async (message) =>
          await new Promise((resolve) => {
            const port = chrome.runtime.connect({ name: message.source });
            port.onMessage.addListener((response: unknown) => {
              resolve(response);
              port.disconnect();
            });
            port.postMessage(message);
          }),
        { ...request, source: "stella-extension-popup" },
      );
    },
  };
};

const tabIdOf = async ({ worker }: Harness, urlPrefix: string) =>
  await worker.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url?.startsWith(prefix))?.id ?? null;
  }, urlPrefix);

/**
 * What a page script does to save a file without any network request. The
 * files are large enough that writing them outlasts the cancel.
 */
const saveFromScript = async (page: Page, href: "blob" | "data") => {
  await page.evaluate((kind) => {
    // A data: URL stays under Chrome's 2 MB URL limit.
    const notes = "case-notes".repeat(kind === "blob" ? 1_000_000 : 120_000);
    const link = document.createElement("a");
    link.href =
      kind === "blob"
        ? URL.createObjectURL(new Blob([notes], { type: "text/plain" }))
        : `data:text/plain,${encodeURIComponent(notes)}`;
    link.download = "notes.txt";
    link.click();
  }, href);
};

/**
 * Each download's source (the creating origin of a `blob:` URL, the scheme
 * of a `data:` URL, or the URL) and whether it finished.
 */
const downloads = async ({ worker }: Harness) =>
  await worker.evaluate(async () =>
    (await chrome.downloads.search({}))
      .map(({ state, url }) => {
        let source = url;
        if (url.startsWith("blob:")) {
          source = new URL(url.slice(5)).origin;
        } else if (url.startsWith("data:")) {
          source = "data:";
        }
        return { saved: state === "complete", source };
      })
      .toSorted((left, right) => left.source.localeCompare(right.source)),
  );

const latestPong = async (stella: Page): Promise<unknown> =>
  await stella.evaluate(() => {
    const pongs: unknown = Reflect.get(window, "__pongs");
    return Array.isArray(pongs) ? pongs.at(-1) : null;
  });

/** Opens the containment fixture; the first load of a new tab can miss routing. */
const openContainmentPage = async (
  send: ReturnType<typeof createCommandSender>["send"],
) => {
  const url = `${FIXTURE_ORIGIN}/containment.html`;
  const first = await send({ action: "open", url });
  return successful(
    first.status === "success" ? first : await send({ action: "open", url }),
  );
};

test("stop and popup changes end a running command at once", async () => {
  test.setTimeout(120_000);
  const harness = await launchExtensionHarness();
  await routeFixtures(harness);
  try {
    // Pairing through the worker proves the stella tab's URL is readable
    // without the activeTab permission.
    const popup = await openExtensionPage(harness);
    const stellaTabId = await tabIdOf(harness, harness.stellaOrigin);
    if (stellaTabId === null) {
      throw new TypeError("stella tab not found");
    }
    expect(await popup.request({ tabId: stellaTabId, type: "pair" })).toEqual({
      status: "done",
    });
    const pong = await latestPong(harness.stella);
    if (
      typeof pong !== "object" ||
      pong === null ||
      !("controllerId" in pong) ||
      typeof pong.controllerId !== "string"
    ) {
      throw new TypeError("Pairing did not notify the stella tab");
    }
    const sender = createCommandSender(harness.stella, pong.controllerId);
    await openContainmentPage(sender.send);

    // Chat Stop: the extension answers right away instead of waiting out
    // the navigation, and cannot claim the page did not change.
    const started = Date.now();
    const stopped = await sender.post({
      action: "open",
      url: `${FIXTURE_ORIGIN}/slow.html`,
    });
    await harness.stella.waitForTimeout(500);
    await sender.cancel();
    expect(await sender.result(stopped)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
    expect(Date.now() - started).toBeLessThan(8000);

    // The session still works after a stop.
    await openContainmentPage(sender.send);

    // Disconnecting from the popup stops a running command the same way,
    // and nothing runs under the old pairing afterwards.
    const interrupted = await sender.post({
      action: "open",
      url: `${FIXTURE_ORIGIN}/slow.html`,
    });
    await harness.stella.waitForTimeout(500);
    expect(await popup.request({ type: "disconnect" })).toEqual({
      status: "done",
    });
    expect(await sender.result(interrupted)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
    expect(await latestPong(harness.stella)).toMatchObject({
      controlledTabId: null,
      controllerId: null,
    });
    expect(await sender.send({ action: "snapshot" })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.staleController,
    });
  } finally {
    await harness.close();
  }
});

test("pages cannot escape the controlled tab or read what they hide", async () => {
  test.setTimeout(180_000);
  const harness = await launchExtensionHarness();
  const intranetRequests = await routeFixtures(harness);
  try {
    await harness.pair(CONTROLLER_ID);
    const { send } = createCommandSender(harness.stella, CONTROLLER_ID);
    let snapshot = await openContainmentPage(send);
    const page = () => ({ revision: snapshot.revision, url: snapshot.url });

    // While stella controls a tab, the user's own downloads elsewhere go
    // through; the stella tab stands in for any tab the user browses in.
    await saveFromScript(harness.stella, "blob");
    await expect
      .poll(async () => await downloads(harness))
      .toEqual([{ saved: true, source: harness.stellaOrigin }]);

    // Hidden text and controls never reach the model.
    expect(snapshot.text).toContain("Visible paragraph stays");
    expect(JSON.stringify(snapshot)).not.toContain(HIDDEN_TEXT_MARKER);
    expect(
      snapshot.elements.some(({ name }) => name === "Concealed action"),
    ).toBe(false);

    // A "show password" toggle turns the field into plain text; it stays
    // unreadable and cannot be filled.
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Reveal key")),
      }),
    );
    const revealed = elementNamed(snapshot.elements, "Account key");
    expect(revealed.value).toBe(undefined);
    expect(JSON.stringify(snapshot)).not.toContain(TOGGLED_SECRET);
    expect(
      await send({
        action: "fill",
        page: page(),
        target: targetOf(revealed),
        value: "replaced",
      }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.sensitiveField });

    // Subresources to a private host are blocked like documents.
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Call intranet")),
      }),
    );
    await harness.stella.waitForTimeout(500);
    expect(intranetRequests).toEqual([]);

    // A page-opened window to a private host is closed.
    const intranetWindow = harness.context.waitForEvent("page");
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(
          elementNamed(snapshot.elements, "Open intranet window"),
        ),
      }),
    );
    const closedWindow = await intranetWindow;
    await expect.poll(() => closedWindow.isClosed()).toBe(true);
    // Chrome reports a page-opened tab only once it exists, so the rules can
    // land after its first request: at most that one request, the documented
    // gap, gets out.
    expect(intranetRequests.length).toBeLessThanOrEqual(1);
    expect(
      intranetRequests.filter((url) => url !== `${INTRANET_ORIGIN}/popup`),
    ).toEqual([]);
    intranetRequests.length = 0;

    // A page-opened public tab stays open for the user, under the same
    // network rules, and chat keeps operating its own tab.
    const newTab = harness.context.waitForEvent("page");
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(
          elementNamed(snapshot.elements, "Open second page in a new tab"),
        ),
      }),
    );
    const openedTab = await newTab;
    await harness.stella.waitForTimeout(500);
    expect(openedTab.isClosed()).toBe(false);
    await expect(openedTab.goto(`${INTRANET_ORIGIN}/admin`)).rejects.toThrow(
      /ERR_BLOCKED_BY_CLIENT/u,
    );
    await expect(
      openedTab.goto(`${harness.stellaOrigin}/chat`),
    ).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/u);
    expect(intranetRequests).toEqual([]);
    snapshot = successful(await send({ action: "snapshot" }));
    expect(snapshot.url).toBe(`${FIXTURE_ORIGIN}/containment.html`);

    // A page saving a file from script (blob: and data: URLs, no network
    // request) is cancelled before the file is written.
    const controlledPage = harness.context
      .pages()
      .find((candidate) => candidate.url() === snapshot.url);
    if (!controlledPage) {
      throw new TypeError("Controlled tab not found");
    }
    await saveFromScript(controlledPage, "blob");
    await saveFromScript(controlledPage, "data");
    await expect
      .poll(async () => await downloads(harness))
      .toEqual([
        { saved: false, source: "data:" },
        { saved: true, source: harness.stellaOrigin },
        { saved: false, source: FIXTURE_ORIGIN },
      ]);

    // A document served without an attachment header that Chrome would
    // save instead of render leaves no file either. (The tab's rules block
    // such responses outright on the network; the routed test response
    // skips those rules, so this exercises the download guard behind them.)
    await send({
      action: "click",
      page: page(),
      target: targetOf(elementNamed(snapshot.elements, "Download binary")),
    });
    await harness.stella.waitForTimeout(1000);
    expect(
      (await downloads(harness)).filter(
        ({ saved, source }) => saved && source.endsWith("/file.bin"),
      ),
    ).toEqual([]);
  } finally {
    await harness.close();
  }
});
