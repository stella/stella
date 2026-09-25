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
  ELSEWHERE_ORIGIN,
  FIXTURE_ORIGIN,
  FIXTURE_PAGES,
  HIDDEN_TEXT_MARKER,
  INTRANET_ORIGIN,
  INTRANET_PAGE,
  REPLACED_SECRET,
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
        body: "binary payload",
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
  await context.route(`${ELSEWHERE_ORIGIN}/**`, serve);
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

/** What a page script does to save a small file without any network request. */
const saveFromScript = async (page: Page, href: "blob" | "data") => {
  await page.evaluate((kind) => {
    const link = document.createElement("a");
    link.href =
      kind === "blob"
        ? URL.createObjectURL(new Blob(["case notes"], { type: "text/plain" }))
        : "data:text/plain,case%20notes";
    link.download = "notes.txt";
    link.click();
  }, href);
};

/**
 * Each download's source (the creating origin of a `blob:` URL, the scheme
 * of a `data:` URL, or the URL) and whether it finished.
 */
const downloads = async ({ worker }: Harness) =>
  await worker.evaluate(async () => {
    const items = await chrome.downloads.search({});
    // Only settled downloads are compared: one still running could yet
    // finish and leave its file.
    if (items.some(({ state }) => state === "in_progress")) {
      return null;
    }
    return items
      .map(({ exists, state, url }) => {
        let source = url;
        if (url.startsWith("blob:")) {
          source = new URL(url.slice(5)).origin;
        } else if (url.startsWith("data:")) {
          source = "data:";
        }
        return { saved: state === "complete" && exists, source };
      })
      .toSorted((left, right) => left.source.localeCompare(right.source));
  });

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

    // The user moves the controlled tab on by hand after chat last saw it:
    // a navigation chat asked for earlier no longer applies to this page.
    const controlledPage = harness.context
      .pages()
      .find((candidate) => candidate.url().endsWith("/containment.html"));
    if (!controlledPage) {
      throw new TypeError("Controlled tab not found");
    }
    await controlledPage.goto(`${FIXTURE_ORIGIN}/page2.html`);
    for (const command of [
      { action: "go-back" },
      { action: "open", url: `${FIXTURE_ORIGIN}/index.html` },
    ] as const) {
      expect(await sender.send(command)).toMatchObject({
        code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot,
      });
    }
    expect(controlledPage.url()).toBe(`${FIXTURE_ORIGIN}/page2.html`);
    // Once chat reads the page again, it may navigate.
    successful(await sender.send({ action: "snapshot" }));
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

    // A reveal that swaps the field for a new element, and prints the value,
    // does not make it readable either.
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Show vault key")),
      }),
    );
    expect(snapshot.text).toContain("Your vault key is [hidden]");
    expect(elementNamed(snapshot.elements, "Vault key").value).toBe(undefined);
    expect(JSON.stringify(snapshot)).not.toContain(REPLACED_SECRET);

    // Fields named like secrets, by whole words only.
    expect(elementNamed(snapshot.elements, "Hotplate").value).toBe(
      "warm plate",
    );
    expect(elementNamed(snapshot.elements, "Photo print").value).toBe(
      "glossy finish",
    );
    for (const name of ["Camel password", "Snake code"]) {
      expect(elementNamed(snapshot.elements, name).value).toBe(undefined);
    }
    expect(JSON.stringify(snapshot)).not.toContain("camel-secret-81");

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

    // Tabs a page opens are confined from their very first request, whether
    // the page keeps a handle on them or not and whichever frame opens them:
    // none reaches the intranet host, and each is closed.
    const popupOpeners = [
      "Open intranet window",
      "Open intranet window without opener",
      "Open intranet tab",
      "Frame opens intranet",
    ];
    for (const name of popupOpeners) {
      const popup = harness.context.waitForEvent("page");
      snapshot = successful(
        await send({
          action: "click",
          page: page(),
          target: targetOf(elementNamed(snapshot.elements, name)),
        }),
      );
      const opened = await popup;
      await expect.poll(() => opened.isClosed()).toBe(true);
    }
    // A public page opened without an opener stays confined too: neither its
    // script nor its own navigation reaches the intranet host.
    const beacon = harness.context.waitForEvent("page");
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Open beacon page")),
      }),
    );
    const beaconPage = await beacon;
    await harness.stella.waitForTimeout(1500);
    expect(intranetRequests).toEqual([]);
    await beaconPage.close();

    // A tab no page opened is the user's once Chrome has had the moment it
    // takes to name an opener: it reaches the intranet host.
    const userTab = await harness.context.newPage();
    await harness.stella.waitForTimeout(1500);
    await userTab.goto(`${INTRANET_ORIGIN}/user-tab`);
    expect(intranetRequests).toEqual([`${INTRANET_ORIGIN}/user-tab`]);
    intranetRequests.length = 0;
    await userTab.close();

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
    // A small file a cross-origin frame inside the controlled tab saves is
    // traced to that frame, and gone even when it finished first, although
    // the user has that frame's site open in a tab of their own.
    const userSiteTab = await harness.context.newPage();
    await harness.stella.waitForTimeout(1500);
    await userSiteTab.goto(`${ELSEWHERE_ORIGIN}/landing.html`);
    await controlledPage
      .frameLocator("iframe[title='Tools frame']")
      .locator("body")
      .evaluate(() => {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(
          new Blob(["frame notes"], { type: "text/plain" }),
        );
        link.download = "frame-notes.txt";
        document.body.append(link);
        link.click();
      });
    await expect
      .poll(async () => await downloads(harness))
      .toEqual([
        { saved: false, source: "data:" },
        { saved: true, source: harness.stellaOrigin },
        { saved: false, source: ELSEWHERE_ORIGIN },
        { saved: false, source: FIXTURE_ORIGIN },
      ]);
    // The toolbar icon counts the stopped downloads.
    expect(
      await harness.worker.evaluate(
        async () => await chrome.action.getBadgeText({}),
      ),
    ).toBe("3");

    // A document served without an attachment header that Chrome would
    // save instead of render leaves no file either. (The tab's rules block
    // such responses outright on the network; the routed test response
    // skips those rules, so this exercises the download guard behind them.)
    await send({
      action: "click",
      page: page(),
      target: targetOf(elementNamed(snapshot.elements, "Download binary")),
    });
    await expect
      .poll(async () => {
        const settled = await downloads(harness);
        return settled?.filter(({ source }) => source.endsWith("/file.bin"));
      })
      .toEqual([{ saved: false, source: `${FIXTURE_ORIGIN}/file.bin` }]);
  } finally {
    await harness.close();
  }
});
