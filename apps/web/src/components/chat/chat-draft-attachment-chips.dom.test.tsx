import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { ChatAttachmentChip, ChatDraftAttachmentChips } =
  await import("./chat-draft-attachment-chips");
const en = (await import("@/i18n/langs/en.json")).default;
const cs = (await import("@/i18n/langs/cs.json")).default;
const ar = (await import("@/i18n/langs/ar.json")).default;

const locales = { en, cs, ar };

afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

for (const [locale, messages] of Object.entries(locales)) {
  test(`sent pasted text disclosure preserves exact text in ${locale}`, () => {
    const text =
      "\r\n  \t\r\n  První neprázdný řádek  \r\n\t<text> & العربية\n\n";
    const view = render(
      <IntlProvider locale={locale} messages={messages}>
        <TooltipProvider>
          <div dir={locale === "ar" ? "rtl" : "ltr"}>
            <ChatAttachmentChip
              behavior={{ type: "sent" }}
              item={{ type: "pasted_text", id: "pasted", text }}
            />
          </div>
        </TooltipProvider>
      </IntlProvider>,
    );
    const expand = view.getByRole("button", {
      name: messages.chat.pastedText.expand,
    });
    const content = view.container.querySelector("pre");
    expect(content).not.toBeNull();
    expect(content?.hidden).toBe(true);
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(expand.getAttribute("aria-controls")).toBe(content?.id);
    expect(view.getByText("První neprázdný řádek").textContent).toBe(
      "  První neprázdný řádek  ",
    );
    expect(
      view.queryByRole("button", { name: messages.common.remove }),
    ).toBeNull();

    expand.focus();
    expect(document.activeElement).toBe(expand);
    expect(expand.tagName).toBe("BUTTON");
    fireEvent.click(expand);
    expect(content?.hidden).toBe(false);
    expect(content?.textContent).toBe(text);
    expect(content?.getAttribute("contenteditable")).toBeNull();
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(expand);

    fireEvent.click(
      view.getByRole("button", { name: messages.common.showLess }),
    );
    expect(content?.hidden).toBe(true);
    expect(content?.textContent).toBe(text);
  });
}

test("draft pasted text exposes separate expansion and removal actions", () => {
  const removed: string[] = [];
  const expanded: string[] = [];
  const view = render(
    <IntlProvider locale="cs" messages={cs}>
      <TooltipProvider>
        <ChatDraftAttachmentChips
          files={[
            { type: "pasted_text", id: "pasted", text: "\nText k vložení\n" },
            {
              type: "file",
              id: "file",
              filename: "podání.txt",
              mimeType: "text/plain",
              file: new File(["podání"], "podání.txt", { type: "text/plain" }),
            },
          ]}
          onExpand={(id) => expanded.push(id)}
          onRemove={(id) => removed.push(id)}
        />
      </TooltipProvider>
    </IntlProvider>,
  );
  const expand = view.getByRole("button", { name: "Zobrazit v textovém poli" });
  expand.focus();
  expect(document.activeElement).toBe(expand);
  expect(expand.tagName).toBe("BUTTON");
  fireEvent.click(expand);
  expect(expanded).toEqual(["pasted"]);
  expect(removed).toEqual([]);
  const remove = view.getAllByRole("button", { name: cs.common.remove });
  expect(remove).toHaveLength(2);
  fireEvent.click(remove[0]);
  fireEvent.click(remove[1]);
  expect(removed).toEqual(["pasted", "file"]);
  expect(expanded).toEqual(["pasted"]);
});

test("whitespace-only pasted text has a translated title", () => {
  const view = render(
    <IntlProvider locale="en" messages={en}>
      <TooltipProvider>
        <ChatAttachmentChip
          behavior={{ type: "sent" }}
          item={{ type: "pasted_text", id: "blank", text: " \r\n\t\n" }}
        />
      </TooltipProvider>
    </IntlProvider>,
  );
  expect(view.getByText(en.chat.pastedText.title)).toBeDefined();
});
