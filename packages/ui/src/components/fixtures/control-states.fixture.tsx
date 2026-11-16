import { createRoot } from "react-dom/client";

import { panic } from "better-result";
import { cn } from "../../lib/utils";

import { COMPOSER_PICKER_TRIGGER_CLASS } from "../composer-tokens";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../menu";
import { Popover, PopoverTrigger, PopoverPanel } from "../popover";
import { Button } from "../button";
import { TruncatedText } from "../truncated-text";
import { Textarea } from "../textarea";

// States the class names alone cannot show: how a selected plain target
// looks beside an unselected one, and the height a fixed textarea's rows give.
const ControlStatesFixture = () => (
  <main className="flex w-96 flex-col items-start gap-4 p-4">
    <div className="flex gap-2">
      <Button aria-label="Unselected card" variant="plain">
        <span className="block p-4">Card</span>
      </Button>
      <Button aria-label="Selected card" selected variant="plain">
        <span className="block p-4">Card</span>
      </Button>
    </div>
    <div className="flex max-w-full items-start gap-2" data-testid="caption-controls">
      <span className={COMPOSER_PICKER_TRIGGER_CLASS} data-testid="caption-reference">Matter</span>
      <Menu>
        <MenuTrigger appearance="caption" className={({ open }) => open ? "outline-solid" : "outline-none"}>Matter</MenuTrigger>
        <MenuPopup><MenuItem>Choose matter</MenuItem></MenuPopup>
      </Menu>
      <Popover>
        <PopoverTrigger appearance="caption" className={({ open }) => open ? "outline-solid" : "outline-none"}>Status</PopoverTrigger>
        <PopoverPanel><p>Current sources</p><Button size="sm">Coverage details</Button></PopoverPanel>
      </Popover>
    </div>
    <div className="flex w-full gap-2" dir="rtl">
      <span className={cn(COMPOSER_PICKER_TRIGGER_CLASS, "max-w-[220px]")} data-testid="rtl-caption-reference"><TruncatedText hint={false}>اسم ملف طويل يحتاج إلى مساحة إضافية للعرض</TruncatedText></span>
      <Menu>
        <MenuTrigger appearance="caption" className="max-w-[220px]" data-testid="rtl-caption"><TruncatedText hint={false}>اسم ملف طويل يحتاج إلى مساحة إضافية للعرض</TruncatedText></MenuTrigger>
        <MenuPopup><MenuItem>Choose matter</MenuItem></MenuPopup>
      </Menu>
    </div>
    <Button className="h-12 w-full justify-start rounded-none px-3" variant="ghost">Original inspector action</Button>
    <Button className="w-full" size="inspector-row" variant="ghost">Duplicate matter</Button>
    <Button className="w-full" disabled size="inspector-row" variant="ghost">Duplicate content</Button>
    <Textarea aria-label="Growing note" />
    <Textarea aria-label="One fixed row" fieldSizing="fixed" rows={1} />
    <Textarea aria-label="Two fixed rows" fieldSizing="fixed" rows={2} />
  </main>
);

const root = document.querySelector("#root");
if (root === null) {
  panic("Missing control states fixture root");
}
createRoot(root).render(<ControlStatesFixture />);
