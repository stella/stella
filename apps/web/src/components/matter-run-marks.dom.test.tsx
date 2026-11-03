import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import arabicMessages from "@/i18n/langs/ar.json";
import czechMessages from "@/i18n/langs/cs.json";
import englishMessages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { MatterRunBadge, MatterRunMarks } = await import("./matter-run-marks");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const renderIn = (node: React.ReactNode, locale: "ar" | "cs" | "en" = "en") => {
  const messages = {
    ar: arabicMessages,
    cs: czechMessages,
    en: englishMessages,
  }[locale];
  return render(
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      {node}
    </IntlProvider>,
  );
};

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("[role='img']")].map((element) =>
    element.getAttribute("aria-label"),
  );

describe("MatterRunMarks", () => {
  test("a matter with no open chat renders nothing", () => {
    expect(
      renderIn(<MatterRunMarks status={undefined} />).container.innerHTML,
    ).toBe("");
    expect(
      renderIn(<MatterRunMarks status={{ needsYou: 0, working: 0 }} />)
        .container.innerHTML,
    ).toBe("");
  });

  test("chats waiting on the reader come before chats at work, each named", () => {
    const { container } = renderIn(
      <MatterRunMarks status={{ needsYou: 1, working: 3 }} />,
    );
    expect(labels(container)).toEqual([
      "1 chat is waiting for you",
      "3 chats are working",
    ]);
  });

  test("a count follows a mark only when there is more than one", () => {
    const { container } = renderIn(
      <MatterRunMarks status={{ needsYou: 1, working: 3 }} />,
    );
    const [needsYou, working] = container.querySelectorAll("[role='img']");
    expect(needsYou?.textContent).toBe("!");
    expect(working?.textContent).toBe("3");
  });

  test("labels follow each locale's plural rules", () => {
    expect(
      labels(
        renderIn(<MatterRunMarks status={{ needsYou: 2, working: 5 }} />, "cs")
          .container,
      ),
    ).toEqual(["Na vás čekají 2 chaty", "Pracuje 5 chatů"]);
    expect(
      labels(
        renderIn(<MatterRunMarks status={{ needsYou: 2, working: 0 }} />, "ar")
          .container,
      ),
    ).toEqual(["دردشتان بانتظارك"]);
  });
});

describe("MatterRunBadge", () => {
  test("shows only the state that matters most", () => {
    expect(
      labels(
        renderIn(<MatterRunBadge status={{ needsYou: 2, working: 4 }} />)
          .container,
      ),
    ).toEqual(["2 chats are waiting for you"]);
    expect(
      labels(
        renderIn(<MatterRunBadge status={{ needsYou: 0, working: 1 }} />)
          .container,
      ),
    ).toEqual(["1 chat is working"]);
  });

  test("a matter with nothing open has no badge", () => {
    expect(
      renderIn(<MatterRunBadge status={undefined} />).container.innerHTML,
    ).toBe("");
  });
});
