import { useEffect } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "../combobox";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../select";

// One label far wider than the 16rem popup. A list item must clip it inside
// the popup rather than widen its content track past the popup edge.
const LONG_LABEL = `${"Very long option label ".repeat(12)}end`;
const ITEMS = [LONG_LABEL, "Short"] as const;

const ListItemsFixture = () => {
  useEffect(() => {
    document.documentElement.dataset["listItemsReady"] = "true";
    return () => {
      delete document.documentElement.dataset["listItemsReady"];
    };
  }, []);

  return (
    <main className="grid w-64 gap-4 p-8">
      <Combobox items={ITEMS}>
        <ComboboxInput aria-label="Order" placeholder="Order" />
        <ComboboxPopup className="w-64">
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                <span className="block truncate">{item}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>

      <Select defaultValue="Short">
        <SelectTrigger aria-label="Category">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup className="w-64">
          {ITEMS.map((item) => (
            <SelectItem key={item} value={item}>
              <span className="block truncate">{item}</span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </main>
  );
};

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}

createRoot(rootElement).render(<ListItemsFixture />);
