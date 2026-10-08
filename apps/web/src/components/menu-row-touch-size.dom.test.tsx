import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act } = await import("react");
const { cleanup, render, waitFor } = await import("@testing-library/react");
const {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} = await import("@stll/ui/menu");

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("menu rows", () => {
  // The primitive owns the row height: compact under a fine pointer, a
  // 44px target under a coarse one. A row that needs its own height
  // override to be touchable stands taller than its neighbours on desktop.
  test("every row kind is compact on desktop and touch-sized on touch", async () => {
    render(
      <Menu open>
        <MenuTrigger />
        <MenuPopup>
          <MenuItem />
          <MenuCheckboxItem checked={false} />
          <MenuRadioGroup value="a">
            <MenuRadioItem value="a" />
          </MenuRadioGroup>
          <MenuSub>
            <MenuSubTrigger />
          </MenuSub>
        </MenuPopup>
      </Menu>,
    );

    // menuitem (item and submenu trigger), menuitemcheckbox, menuitemradio.
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll('[role^="menuitem"]')];
      expect(found).toHaveLength(4);
      return found;
    });
    for (const row of rows) {
      expect(row.className.split(/\s+/u)).toEqual(
        expect.arrayContaining([
          "min-h-8",
          "sm:min-h-7",
          "pointer-coarse:min-h-11",
        ]),
      );
    }
  });
});
