import type { ReactNode } from "react";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";

import type { menuCommitBenches } from "../-visual-metadata";

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => `Row ${String(index + 1)}`);
const ROWS = rows(3);
const MANY_ROWS = rows(24);

/**
 * One menu per bench, each differing from the plain one in a single thing, so
 * the commits a menu takes to open and to close can be told apart by cause:
 * the primitive alone, the shared wrapper, a tooltip on the trigger, radio
 * rows, and a long list.
 */
const BENCH = {
  primitive: (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger nativeButton>primitive</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner>
          <MenuPrimitive.Popup>
            {ROWS.map((row) => (
              <MenuPrimitive.Item key={row}>{row}</MenuPrimitive.Item>
            ))}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  ),
  plain: (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        plain
      </MenuTrigger>
      <MenuPopup>
        {ROWS.map((row) => (
          <MenuItem key={row}>{row}</MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  ),
  tooltip: (
    <Menu>
      <MenuTrigger
        render={<Button size="sm" variant="outline" />}
        tooltip="Opens the menu"
      >
        tooltip
      </MenuTrigger>
      <MenuPopup>
        {ROWS.map((row) => (
          <MenuItem key={row}>{row}</MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  ),
  radio: (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        radio
      </MenuTrigger>
      <MenuPopup>
        <MenuRadioGroup value={ROWS.at(0)}>
          {ROWS.map((row) => (
            <MenuRadioItem key={row} value={row}>
              {row}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  ),
  many: (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        many
      </MenuTrigger>
      <MenuPopup>
        {MANY_ROWS.map((row) => (
          <MenuItem key={row}>{row}</MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  ),
} as const satisfies Record<keyof typeof menuCommitBenches, ReactNode>;

export const MenuCommitsPlayground = () => (
  <div className="flex flex-col gap-6 p-4">
    {Object.entries(BENCH).map(([bench, menu]) => (
      <section
        className="bg-card flex w-60 flex-col items-start gap-2 rounded-lg border p-3"
        data-playground-section={`menu-commits:${bench}`}
        key={bench}
      >
        {menu}
      </section>
    ))}
  </div>
);
