import { expect, test } from "@playwright/test";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  type BrowserControlCommand,
} from "@stll/api-contract/browser-control";

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
  INTRANET_ORIGIN,
  INTRANET_PAGE,
  INTRANET_SECRET,
} from "./fixtures/pages";

const CONTROLLER_ID = "controller-protocol";

test("reads frames and shadow roots, pages text, and enforces the origin policy", async () => {
  test.setTimeout(180_000);
  const harness = await launchExtensionHarness({
    serveLoopback: (url) =>
      url.startsWith("/plain")
        ? "<!doctype html><html><body><p>Plain HTTP page.</p></body></html>"
        : undefined,
  });
  const { context, stella, stellaOrigin } = harness;
  const serveFixture = async (
    route: Parameters<Parameters<typeof context.route>[1]>[0],
  ) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/redirect") {
      await route.fulfill({
        headers: { location: `${ELSEWHERE_ORIGIN}/landing.html` },
        status: 302,
      });
      return;
    }
    const body = FIXTURE_PAGES[pathname];
    await (body === undefined
      ? route.fulfill({ body: "not found", status: 404 })
      : route.fulfill({
          body,
          contentType: "text/html; charset=utf-8",
          status: 200,
        }));
  };
  await context.route(`${FIXTURE_ORIGIN}/**`, serveFixture);
  await context.route(`${ELSEWHERE_ORIGIN}/**`, serveFixture);
  // Reachable if anything lets the controlled tab request it; the tab's
  // network rules must keep every request from getting here.
  const intranetRequests: string[] = [];
  await context.route(`${INTRANET_ORIGIN}/**`, async (route) => {
    intranetRequests.push(route.request().url());
    await route.fulfill({
      body: INTRANET_PAGE,
      contentType: "text/html; charset=utf-8",
      status: 200,
    });
  });

  try {
    await harness.pair(CONTROLLER_ID);
    const sender = createCommandSender(stella, CONTROLLER_ID);
    const send = async (
      command: BrowserControlCommand,
      replayToolCallId?: string,
    ) =>
      await sender.send(
        command,
        replayToolCallId === undefined ? {} : { toolCallId: replayToolCallId },
      );

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
    for (const name of [
      "Password field",
      "Card number",
      "One-time code",
      "New password",
      "Masked PIN",
      "Card expiry month",
    ]) {
      expect(elementNamed(snapshot.elements, name).value).toBe(undefined);
    }
    for (const secret of ["4111111111111111", "424242", "hunter2", "97531"]) {
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    }
    expect(JSON.stringify(snapshot)).not.toContain(INTRANET_SECRET);
    expect(snapshot.elements.some(({ name }) => name === "Reset printer")).toBe(
      false,
    );
    expect(intranetRequests).toEqual([]);

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
    for (const name of ["Card number", "One-time code", "Masked PIN"]) {
      expect(
        await send({
          action: "fill",
          page: page(),
          target: targetOf(elementNamed(snapshot.elements, name)),
          value: "0000",
        }),
      ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.sensitiveField });
    }
    expect(
      await send({
        action: "select",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Card expiry month")),
        value: "01",
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
        action: "press-key",
        key: "Enter",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Search query")),
      }),
    );
    expect(snapshot.text).toContain("Submitted: notice period");
    expect(
      snapshot.elements.some(({ name }) => name === "Archive (disabled)"),
    ).toBe(false);

    // Two identical "Delete" buttons differ only by their row. Removing the
    // first row moves the second row's button onto the first target's
    // child-index path; the bound row context catches it before the wrong
    // case is deleted.
    const deleteButtons = snapshot.elements.filter(
      ({ name, role }) => name === "Delete" && role === "button",
    );
    expect(deleteButtons.map((button) => button.context)).toEqual([
      "Case 12 C 345/2024 Delete",
      "Case 7 T 89/2023 Delete",
    ]);
    const firstDeleteElement = deleteButtons.at(0);
    if (!firstDeleteElement) {
      throw new TypeError("Expected a Delete button");
    }
    const firstDelete = targetOf(firstDeleteElement);
    snapshot = successful(
      await send({
        action: "click",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Drop first row")),
      }),
    );
    expect(
      await send({ action: "click", page: page(), target: firstDelete }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.staleSnapshot });
    snapshot = successful(await send({ action: "snapshot" }));
    expect(snapshot.text).not.toContain("Deleted case");
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

    // A link to an intranet host is blocked in the network layer; the click
    // ran, so its outcome is reported as unknown rather than as a failure.
    expect(
      await send({
        action: "click",
        page: page(),
        target: targetOf(elementNamed(snapshot.elements, "Printer admin")),
      }),
    ).toMatchObject({ code: BROWSER_CONTROL_ERROR_CODE.outcomeUnknown });
    expect(intranetRequests).toEqual([]);

    const redirected = await send({
      action: "open",
      url: `${FIXTURE_ORIGIN}/redirect`,
    });
    expect(redirected).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.redirected,
    });
    expect(JSON.stringify(redirected)).not.toContain("Private text");
    // Route interception does not follow the redirect chain to the second
    // host, so the landing page is read through a fresh, separately approved
    // navigation, which is the flow the guard prescribes.
    snapshot = successful(
      await send({ action: "open", url: `${ELSEWHERE_ORIGIN}/landing.html` }),
    );
    expect(snapshot.url).toBe(`${ELSEWHERE_ORIGIN}/landing.html`);
    expect(snapshot.text).toContain("Private text on another origin");

    const controlled = context
      .pages()
      .find((candidate) => candidate.url().startsWith(ELSEWHERE_ORIGIN));
    if (!controlled) {
      throw new TypeError("Controlled tab not found");
    }
    // Plain HTTP, here the loopback stella server, never loads in the
    // controlled tab, even when the user navigates it by hand.
    await expect(controlled.goto(`${stellaOrigin}/plain`)).rejects.toThrow(
      /ERR_BLOCKED_BY_CLIENT/u,
    );
    expect(await send({ action: "snapshot" })).toMatchObject({
      code: BROWSER_CONTROL_ERROR_CODE.unsupportedPage,
    });
  } finally {
    await harness.close();
  }
});
