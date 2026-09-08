import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { ColorPicker } from "../color-picker";

const PRESETS = [
  { color: "#ef4444", label: "Red", value: "EF4444" },
  { color: "#3b82f6", label: "Blue", value: "3B82F6" },
];

const ColorPickerFixture = () => {
  const [value, setValue] = useState("EF4444");

  useEffect(() => {
    document.documentElement.dataset["colorPickerReady"] = "true";
    return () => {
      delete document.documentElement.dataset["colorPickerReady"];
    };
  }, []);

  return (
    <main>
      <ColorPicker
        columns={2}
        moreLabel="Custom color"
        onSelect={setValue}
        presets={PRESETS}
        value={value}
      >
        <button type="button">Choose color</button>
      </ColorPicker>
      <output aria-label="Selected color">{value}</output>
    </main>
  );
};

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}

createRoot(rootElement).render(<ColorPickerFixture />);
