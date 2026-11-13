import { expect, type Page, test } from "@playwright/test";

import { BROWSER_CONTROL_ERROR_CODE } from "@stll/api-contract/browser-control";

import {
  createCommandSender,
  elementNamed,
  launchExtensionHarness,
  openInNewControlledTab,
  successful,
  targetOf,
} from "./fixtures/harness";
import {
  ELSEWHERE_ORIGIN,
  FIXTURE_ORIGIN,
  FIXTURE_PAGES,
  HANDOFF_SECRET,
  HIDDEN_TEXT_MARKER,
  INTRANET_ORIGIN,
  INTRANET_PAGE,
  REPLACED_SECRET,
  TOGGLED_SECRET,
} from "./fixtures/pages";

const CONTROLLER_ID = "controller-containment";

type Harness = Awaited<ReturnType<typeof launchExtensionHarness>>;

/** Serves the fixtures, a never-quick page and a binary, and records intranet traffic. */
const routeFixtures = async (
  { context }: Harness,
  waitForSlowResponse?: () => Promise<void>,
) => {
  const intranetRequests: string[] = [];
  const serve = async (
    route: Parameters<Parameters<typeof context.route>[1]>[0],
  ) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/slow.html") {
      if (waitForSlowResponse === undefined) {
        throw new TypeError("Slow fixture requires an explicit response gate");
      }
      await waitForSlowResponse();
      await route
        .fulfill({ body: "<p>Slow page</p>", contentType: "text/html" })
        // swallow-ok: releasing the response races deliberate navigation cancellation in the containment stop test
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
      .toSorted(
        (left, right) =>
          left.source.localeCompare(right.source) ||
          Number(left.saved) - Number(right.saved),
      );
  });

const latestPong = async (stella: Page): Promise<unknown> =>
  await stella.evaluate(() => {
    const pongs: unknown = Reflect.get(window, "__pongs");
    return Array.isArray(pongs) ? pongs.at(-1) : null;
  });

/** Opens the containment fixture; the first load of a new tab can miss routing. */
const openContainmentPage = async (
  harness: Harness,
  send: ReturnType<typeof createCommandSender>["send"],
) => {
  const url = `${FIXTURE_ORIGIN}/containment.html`;
  const opened = await send({ action: "open", url });
  if (opened.status === "success") {
    return opened.snapshot;
  }
  return await openInNewControlledTab(harness, send, url);
};

test("stop and popup changes end a running command at once", async () => {
  test.setTimeout(120_000);
  const harness = await launchExtensionHarness();
  const releaseSlowResponses = Promise.withResolvers<undefined>();
  let slowResponsesReleased = 0;
  await routeFixtures(harness, async () => {
    await releaseSlowResponses.promise;
    slowResponsesReleased += 1;
  });
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
    await openContainmentPage(harness, sender.send);

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
    await openContainmentPage(harness, sender.send);

    // Chat Stop: the extension answers right away instead of waiting out
    // the navigation, and cannot claim the page did not change.
    const slowRequest = harness.context.waitForEvent("request", {
      predicate: (request) => request.url() === `${FIXTURE_ORIGIN}/slow.html`,
    });
    const stopped = await sender.post({
      action: "open",
      url: `${FIXTURE_ORIGIN}/slow.html`,
    });
    await slowRequest;
    await sender.cancel();
    expect(await sender.result(stopped)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
    expect(slowResponsesReleased).toBe(0);

    // The session still works after a stop.
    await openContainmentPage(harness, sender.send);

    // Disconnecting from the popup stops a running command the same way,
    // and nothing runs under the old pairing afterwards.
    const interruptedRequest = harness.context.waitForEvent("request", {
      predicate: (request) => request.url() === `${FIXTURE_ORIGIN}/slow.html`,
    });
    const interrupted = await sender.post({
      action: "open",
      url: `${FIXTURE_ORIGIN}/slow.html`,
    });
    await interruptedRequest;
    expect(await popup.request({ type: "disconnect" })).toEqual({
      status: "done",
    });
    expect(await sender.result(interrupted)).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
    });
    expect(slowResponsesReleased).toBe(0);
    expect(await latestPong(harness.stella)).toMatchObject({
      controlledTabId: null,
      controllerId: null,
    });
    expect(await sender.send({ action: "snapshot" })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.staleController,
    });
  } finally {
    releaseSlowResponses.resolve(undefined);
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
    let snapshot = await openContainmentPage(harness, send);
    const page = () => ({ revision: snapshot.revision, url: snapshot.url });

    // The popup names the tab stella keeps contained, so the user can find
    // it among their tabs and disconnect; the connected address is in the
    // status tooltip and read out to screen readers.
    const popupPage = await harness.context.newPage();
    await popupPage.goto(new URL("/popup.html", harness.worker.url()).href);
    await expect(popupPage.locator("#contained-tabs-label")).toHaveText(
      "Using:",
    );
    await expect(popupPage.locator(".tab-name")).toHaveText(["Containment"]);
    await expect(popupPage.locator(".tab-host")).toHaveText([
      new URL(FIXTURE_ORIGIN).host,
    ]);
    const status = popupPage.locator("#status");
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toHaveAttribute("title", harness.stellaOrigin);
    await expect(popupPage.locator("#status-text")).toHaveText("Connected");
    await expect(popupPage.locator("#status-origin")).toHaveText(
      harness.stellaOrigin,
    );
    await expect(popupPage.locator("#purpose")).toBeHidden();
    await expect(popupPage.getByRole("button")).toHaveText([
      "Disconnect",
      "Remove access",
      "Use with stella desktop",
    ]);
    await popupPage.close();

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

    // A password the user types after chat's last read, which the page then
    // swaps into a plain field and prints, is still withheld.
    const handoffPage = harness.context
      .pages()
      .find((candidate) => candidate.url() === snapshot.url);
    if (!handoffPage) {
      throw new TypeError("Controlled tab not found");
    }
    await handoffPage.getByLabel("Handoff key").fill(HANDOFF_SECRET);
    await handoffPage.getByText("Show handoff key").click();
    snapshot = successful(await send({ action: "snapshot" }));
    expect(elementNamed(snapshot.elements, "Handoff key").value).toBe(
      undefined,
    );
    expect(snapshot.text).toContain("You typed [hidden]");
    expect(JSON.stringify(snapshot)).not.toContain(HANDOFF_SECRET);

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
    // request) is cancelled before the file is written, and so is one a
    // cross-origin frame inside the controlled tab saves: only the
    // controlled tab has that origin open, and a `data:` URL saved from an
    // https page carries no referrer to trace.
    const controlledPage = harness.context
      .pages()
      .find((candidate) => candidate.url() === snapshot.url);
    if (!controlledPage) {
      throw new TypeError("Controlled tab not found");
    }
    await saveFromScript(controlledPage, "blob");
    await saveFromScript(controlledPage, "data");
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
    // A file the user saves from their own tab goes through, even on a site
    // the controlled tab also has open: the user may have started it, and
    // stopping it would leave them no way to get it. A `data:` URL the user
    // saves from an https page carries no referrer, so nothing can tell it
    // from one a confined page saved: it is stopped while stella controls a
    // tab.
    const userSiteTab = await harness.context.newPage();
    await harness.stella.waitForTimeout(500);
    await userSiteTab.goto(`${ELSEWHERE_ORIGIN}/landing.html`);
    await saveFromScript(userSiteTab, "blob");
    await saveFromScript(userSiteTab, "data");
    await expect
      .poll(async () => await downloads(harness))
      .toEqual([
        { saved: false, source: "data:" },
        { saved: false, source: "data:" },
        { saved: true, source: harness.stellaOrigin },
        { saved: false, source: ELSEWHERE_ORIGIN },
        { saved: true, source: ELSEWHERE_ORIGIN },
        { saved: false, source: FIXTURE_ORIGIN },
      ]);
    // The toolbar icon counts the stopped downloads. The count is recorded
    // after the download settles, so it is polled.
    await expect
      .poll(
        async () =>
          await harness.worker.evaluate(
            async () => await chrome.action.getBadgeText({}),
          ),
      )
      .toBe("4");

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

/** Hosts for files a navigation turns into downloads. */
const PAYLOAD_ORIGIN = "https://payload.stella-test.example";
const USER_SITE_ORIGIN = "https://files.stella-test.example";
const USER_FRAME_ORIGIN = "https://viewer.stella-test.example";
const USER_CONTENT_ORIGIN = "https://content.stella-test.example";

/** Bytes Chrome sniffs as binary, so a page response becomes a download. */
const BINARY_BODY = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 255, 254, 0]);

/**
 * Responses the tab's network rules let through but Chrome still saves:
 * `text/plain` with a binary body, and no `Content-Type` at all. One more
 * reaches the first through a server redirect. The user's site serves a
 * page whose frame on another host loads a file from a third host, sent as
 * an attachment with no referrer, as file viewers do.
 */
const routeNavigationDownloads = async ({ context }: Harness) => {
  await context.route(`${PAYLOAD_ORIGIN}/**`, async (route) => {
    const { pathname, search } = new URL(route.request().url());
    if (pathname === "/redirect") {
      await route.fulfill({
        headers: { location: `${PAYLOAD_ORIGIN}/plain.bin?via=redirect` },
        status: 302,
      });
      return;
    }
    await (pathname === "/untyped.bin"
      ? route.fulfill({ body: BINARY_BODY })
      : route.fulfill({
          body: BINARY_BODY,
          contentType: "text/plain",
          headers: { "x-variant": search },
        }));
  });
  await context.route(`${USER_SITE_ORIGIN}/**`, async (route) => {
    await route.fulfill({
      body: `<!doctype html><html><head><title>Files</title></head><body>
<iframe src="${USER_FRAME_ORIGIN}/viewer.html" title="Viewer"></iframe>
</body></html>`,
      contentType: "text/html",
    });
  });
  await context.route(`${USER_FRAME_ORIGIN}/**`, async (route) => {
    await route.fulfill({
      body: `<!doctype html><html><head><meta name="referrer" content="no-referrer"></head><body>Viewer</body></html>`,
      contentType: "text/html",
    });
  });
  await context.route(`${USER_CONTENT_ORIGIN}/**`, async (route) => {
    await route.fulfill({
      body: BINARY_BODY,
      contentType: "application/pdf",
      headers: { "content-disposition": 'attachment; filename="report.pdf"' },
    });
  });
};

/** Clicks a link to `url` that sends no referrer, from inside `scope`. */
const followWithoutReferrer = async (
  scope: Page | ReturnType<Page["frameLocator"]>,
  url: string,
  target: "_blank" | "_self" = "_self",
) => {
  await scope.locator("body").evaluate(
    (body, { href, opens }) => {
      const link = document.createElement("a");
      link.href = href;
      link.referrerPolicy = "no-referrer";
      link.rel = "noopener noreferrer";
      link.target = opens;
      body.append(link);
      link.click();
    },
    { href: url, opens: target },
  );
};

/** Every settled download's address, final address and whether it was saved. */
const downloadsByUrl = async ({ worker }: Harness) =>
  await worker.evaluate(async () => {
    const items = await chrome.downloads.search({});
    if (items.some(({ state }) => state === "in_progress")) {
      return null;
    }
    return items
      .map(({ exists, finalUrl, state, url }) => ({
        finalUrl,
        saved: state === "complete" && exists,
        url: url.startsWith("data:") ? "data:" : url,
      }))
      .toSorted((left, right) => left.url.localeCompare(right.url));
  });

test("downloads are traced to the tab that navigated to them", async () => {
  // timeout: it launches Chrome with the extension and lets four downloads settle.
  test.setTimeout(120_000);
  const harness = await launchExtensionHarness();
  await routeFixtures(harness);
  await routeNavigationDownloads(harness);
  try {
    await harness.pair(CONTROLLER_ID);
    const { send } = createCommandSender(harness.stella, CONTROLLER_ID);
    const snapshot = await openContainmentPage(harness, send);
    const controlledPage = harness.context
      .pages()
      .find((candidate) => candidate.url() === snapshot.url);
    if (!controlledPage) {
      throw new TypeError("Controlled tab not found");
    }

    // The controlled tab, a frame in it and a tab it opens each load a
    // file the network rules let through, sending no referrer: each is
    // traced to the confined tab that navigated and stopped.
    await followWithoutReferrer(controlledPage, `${PAYLOAD_ORIGIN}/plain.bin`);
    await followWithoutReferrer(
      controlledPage.frameLocator("iframe[title='Tools frame']"),
      `${PAYLOAD_ORIGIN}/untyped.bin`,
    );
    await followWithoutReferrer(
      controlledPage,
      `${PAYLOAD_ORIGIN}/redirect`,
      "_blank",
    );
    await expect
      .poll(async () => await downloadsByUrl(harness))
      .toEqual([
        {
          finalUrl: `${PAYLOAD_ORIGIN}/plain.bin`,
          saved: false,
          url: `${PAYLOAD_ORIGIN}/plain.bin`,
        },
        // A server redirect keeps the address the navigation started at.
        {
          finalUrl: `${PAYLOAD_ORIGIN}/plain.bin?via=redirect`,
          saved: false,
          url: `${PAYLOAD_ORIGIN}/redirect`,
        },
        {
          finalUrl: `${PAYLOAD_ORIGIN}/untyped.bin`,
          saved: false,
          url: `${PAYLOAD_ORIGIN}/untyped.bin`,
        },
      ]);
    await expect
      .poll(
        async () =>
          await harness.worker.evaluate(
            async () => await chrome.action.getBadgeText({}),
          ),
      )
      .toBe("3");

    // In the user's own tab, a frame on another host loads a file from a
    // third host with no referrer: it is traced to the user's tab and saved,
    // and nothing is noted.
    const userTab = await harness.context.newPage();
    // real-time: a new tab counts as the user's only once Chrome has had the
    // moment it takes to report an opener, and none comes.
    await harness.stella.waitForTimeout(1500);
    await userTab.goto(`${USER_SITE_ORIGIN}/files.html`);
    await followWithoutReferrer(
      userTab.frameLocator("iframe[title='Viewer']"),
      `${USER_CONTENT_ORIGIN}/download?id=1`,
    );
    await expect
      .poll(async () =>
        (await downloadsByUrl(harness))?.filter(({ url }) =>
          url.startsWith(USER_CONTENT_ORIGIN),
        ),
      )
      .toEqual([
        {
          finalUrl: `${USER_CONTENT_ORIGIN}/download?id=1`,
          saved: true,
          url: `${USER_CONTENT_ORIGIN}/download?id=1`,
        },
      ]);
    expect(
      await harness.worker.evaluate(
        async () => await chrome.action.getBadgeText({}),
      ),
    ).toBe("3");
  } finally {
    await harness.close();
  }
});

test("the popup names downloads stopped and files kept", async () => {
  const harness = await launchExtensionHarness();
  try {
    const cases = [
      {
        notices: { kept: 2, stopped: 1 },
        text: "Downloads stopped: 1 · kept: 2, check before opening",
      },
      {
        notices: { kept: 1, stopped: 0 },
        text: "Downloads kept: 1, check before opening",
      },
      {
        notices: { kept: 0, stopped: 4 },
        text: "Downloads stopped: 4",
      },
    ];
    for (const { notices, text } of cases) {
      await harness.worker.evaluate(async (stored) => {
        await chrome.storage.session.set({ browserDownloadNotices: stored });
        await chrome.action.setBadgeText({
          text: String(stored.kept + stored.stopped),
        });
      }, notices);
      const popup = await harness.context.newPage();
      await popup.goto(new URL("/popup.html", harness.worker.url()).href);
      await expect(popup.locator("#notice")).toHaveText(text);
      // Shown once: the notice and the badge are cleared.
      expect(
        await harness.worker.evaluate(async () => [
          (await chrome.storage.session.get("browserDownloadNotices"))[
            "browserDownloadNotices"
          ] ?? null,
          await chrome.action.getBadgeText({}),
        ]),
      ).toEqual([null, ""]);
      await popup.close();
    }
  } finally {
    await harness.close();
  }
});
