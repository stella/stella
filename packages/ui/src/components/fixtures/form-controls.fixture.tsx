import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { NumberInput } from "../number-input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../select";

const fixtureStyles = `
  :root {
    --background: #ffffff;
    --foreground: #171717;
    --input: #d4d4d4;
    --popover: #ffffff;
    --popover-foreground: #262626;
    color-scheme: light;
  }
  :root.dark {
    --background: #0a0a0a;
    --foreground: #f5f5f5;
    --input: #404040;
    --popover: #171717;
    --popover-foreground: #f5f5f5;
    color-scheme: dark;
  }
  body { background: var(--background); color: var(--foreground); }
  main { display: grid; gap: 1rem; inline-size: 20rem; padding: 2rem; }
  .bg-background { background-color: var(--background); }
  .bg-popover { background-color: var(--popover); }
  .text-foreground { color: var(--foreground); }
  .text-popover-foreground { color: var(--popover-foreground); }
  [data-slot="select-popup"] { border: 1px solid var(--input); padding: 0.25rem; }
  [data-slot="select-item"] { padding: 0.5rem; }
  [data-slot="number-input-control"] { border: 1px solid var(--input); }
  [data-slot="number-input"] { background: transparent; color: inherit; padding: 0.5rem; }
`;

const FormControlsFixture = () => {
  const [number, setNumber] = useState<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset["formControlsReady"] = "true";
    return () => {
      delete document.documentElement.dataset["formControlsReady"];
    };
  }, []);

  return (
    <main>
      <style>{fixtureStyles}</style>
      <Select defaultValue="first">
        <SelectTrigger aria-label="Category">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="first">First category</SelectItem>
          <SelectItem value="second">Second category</SelectItem>
        </SelectPopup>
      </Select>

      <NumberInput
        inputProps={{ "aria-label": "Quantity" }}
        onValueChange={setNumber}
        value={number}
      />
      <output aria-label="Canonical quantity">{number ?? "empty"}</output>
    </main>
  );
};

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}

createRoot(rootElement).render(<FormControlsFixture />);
