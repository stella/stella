import { useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { Button, ButtonTextRun } from "../button";

// Each case sits in a paragraph narrower than its action, so the browser
// has to decide whether the action breaks with the line.
const PARAGRAPH_CLASS = "w-48 text-sm leading-6";

const ButtonInlineFixture = () => {
  const [presses, setPresses] = useState(0);
  return (
    <main className="flex flex-col items-start gap-6 p-4">
      <p className={PARAGRAPH_CLASS} data-case="run" lang="cs">
        Podle{" "}
        <ButtonTextRun onClick={() => setPresses((count) => count + 1)}>
          rozsudku Nejvyššího soudu ze dne 30. 11. 2016, sp. zn. 29 Cdo
          4632/2015
        </ButtonTextRun>{" "}
        platí totéž.
      </p>
      <output aria-label="Run presses">{presses}</output>
      <p className={PARAGRAPH_CLASS} data-case="inline" lang="cs">
        Podle{" "}
        <Button size="inline">
          rozsudku Nejvyššího soudu ze dne 30. 11. 2016, sp. zn. 29 Cdo
          4632/2015
        </Button>{" "}
        platí totéž.
      </p>
      <div className="flex gap-4">
        <Button selected variant="plain">
          <span className="bg-muted block rounded-lg p-4">Selected card</span>
        </Button>
        <Button variant="plain">
          <span className="bg-muted block rounded-lg p-4">Other card</span>
        </Button>
      </div>
    </main>
  );
};

const root = document.querySelector("#root");
if (root === null) {
  panic("Missing button inline fixture root");
}
createRoot(root).render(<ButtonInlineFixture />);
