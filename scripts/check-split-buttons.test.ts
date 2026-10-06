import { expect, test } from "bun:test";

import { findAdHocSplitButtons } from "./check-split-buttons.ts";

const file = "apps/example/src/actions.tsx";
const primary = `<Button onClick={save}>Save</Button>`;
const chevronMenu = `<Menu><MenuTrigger render={<Button />}><ChevronDownIcon /></MenuTrigger><MenuPopup><MenuItem onClick={saveAs}>Save as</MenuItem></MenuPopup></Menu>`;

test("rejects adjacent primary actions and chevron menus across production wrapper shapes", () => {
  const cases = [
    `<div>${primary}${chevronMenu}</div>`,
    `<ButtonGroup>${primary}${chevronMenu}</ButtonGroup>`,
    `<div><Tooltip render={${primary}} />{hasOptions && (${chevronMenu})}</div>`,
    `<div>{available ? (${primary}) : null}${chevronMenu}</div>`,
    `<div><button type="submit">Save</button>${chevronMenu}</div>`,
    `<div>${primary}<Popover><PopoverTrigger render={<Button />}><ChevronDownIcon /></PopoverTrigger></Popover></div>`,
    `<div>${primary}<Menu><MenuTrigger render={<Button><ChevronDownIcon /></Button>} /></Menu></div>`,
    `const Primary = () => (${primary}); const view = <div><Primary />${chevronMenu}</div>;`,
    `const Primary = () => { if (selected) return (${primary}); return <Button onClick={create} />; }; const view = <div><Primary />${chevronMenu}</div>;`,
    `import { ChevronDownIcon as Down } from "@stll/ui/icons"; import { MenuTrigger as Trigger } from "@stll/ui/components/menu"; const view = <div>${primary}<Menu><Trigger><Down /></Trigger></Menu></div>;`,
  ];
  for (const content of cases) {
    expect(findAdHocSplitButtons(file, content)).toHaveLength(1);
  }
});

test("excludes plain dropdowns, independent controls and chevron navigation", () => {
  const cases = [
    `<Menu><MenuTrigger><ChevronDownIcon /></MenuTrigger></Menu>`,
    `<div>${primary}<Menu><MenuTrigger>Format<ChevronDownIcon /></MenuTrigger></Menu></div>`,
    `<div>${primary}<Menu><MenuTrigger><span>{formatLabel}</span><ChevronDownIcon /></MenuTrigger></Menu></div>`,
    `<div>${primary}<Menu><MenuTrigger><PlusIcon /><ChevronDownIcon /></MenuTrigger></Menu></div>`,
    `<div><InputGroup><Button onClick={clear} /></InputGroup>${chevronMenu}</div>`,
    `<div><div>${primary}</div>${chevronMenu}</div>`,
    `<div>${primary}<Button onClick={next}><ChevronDownIcon /></Button></div>`,
    `<div>${primary}<span>Unrelated section</span>${chevronMenu}</div>`,
    `<SplitButton menuLabel="Save as" onClick={save}><MenuItem /></SplitButton>`,
  ];
  for (const content of cases) {
    expect(findAdHocSplitButtons(file, content)).toEqual([]);
  }
});

test("exempts only the canonical split-button owner", () => {
  const negativeFixture = `<div>${primary}${chevronMenu}</div>`;
  expect(findAdHocSplitButtons(file, negativeFixture)).toHaveLength(1);
  expect(
    findAdHocSplitButtons(
      "packages/ui/src/components/split-button.tsx",
      negativeFixture,
    ),
  ).toEqual([]);
  expect(
    findAdHocSplitButtons(
      "packages/other/src/split-button.tsx",
      negativeFixture,
    ),
  ).toHaveLength(1);
});
