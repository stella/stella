import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register();

const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { lazy, Suspense, useState } = await import("react");
const { Menu, MenuItem, MenuPopup, MenuTrigger } =
  await import("@stll/ui/menu");
const { ChatMenuContent } = await import("./chat-menu-content");
const en = (await import("@/i18n/langs/en.json")).default;
const ar = (await import("@/i18n/langs/ar.json")).default;

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("dir");
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

for (const { locale, label, direction } of [
  { locale: "en", label: en.chat.newChat, direction: "ltr" },
  { locale: "ar", label: ar.chat.newChat, direction: "rtl" },
]) {
  test(`cold chat menu loading preserves the surrounding shell in ${locale}`, async () => {
    document.documentElement.dir = direction;
    let clicks = 0;
    const LoadedItem = () => (
      <MenuItem
        onClick={() => {
          clicks += 1;
        }}
      >
        {label}
      </MenuItem>
    );
    const chunk = Promise.withResolvers<{ default: typeof LoadedItem }>();
    let chunkRequested = false;
    const ColdItem = lazy(async () => {
      chunkRequested = true;
      return chunk.promise;
    });
    const Shell = () => {
      const [open, setOpen] = useState(false);
      return (
        <Suspense fallback={<p data-testid="ancestor-loading" />}>
          <header data-testid="shell">
            <Menu open={open} onOpenChange={setOpen}>
              <MenuTrigger
                onContextMenu={(event) => {
                  event.preventDefault();
                  setOpen(true);
                }}
              >
                {label}
              </MenuTrigger>
              <MenuPopup>
                <ChatMenuContent label={label}>
                  <ColdItem />
                </ChatMenuContent>
              </MenuPopup>
            </Menu>
          </header>
          <main data-testid="page-content">{label}</main>
        </Suspense>
      );
    };

    const view = render(<Shell />);
    expect(chunkRequested).toBe(false);
    fireEvent.contextMenu(view.getByRole("button", { name: label }));
    const fallback = await waitFor(() =>
      view.getByRole("menuitem", { name: label }),
    );
    expect(chunkRequested).toBe(true);
    expect(fallback.getAttribute("aria-disabled")).toBe("true");
    expect(view.queryByTestId("ancestor-loading")).toBeNull();
    expect(view.getByTestId("shell").style.display).not.toBe("none");
    expect(view.getByTestId("page-content").style.display).not.toBe("none");
    fireEvent.click(fallback);
    expect(clicks).toBe(0);

    await act(async () => {
      chunk.resolve({ default: LoadedItem });
      await chunk.promise;
    });
    const loadedItem = await waitFor(() => {
      const item = view.getByRole("menuitem", { name: label });
      expect(item.getAttribute("aria-disabled")).not.toBe("true");
      return item;
    });
    expect(view.queryByTestId("ancestor-loading")).toBeNull();
    fireEvent.click(loadedItem);
    expect(clicks).toBe(1);
  });
}
