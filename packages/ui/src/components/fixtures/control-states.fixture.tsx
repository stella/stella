import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { Button } from "../button";
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
