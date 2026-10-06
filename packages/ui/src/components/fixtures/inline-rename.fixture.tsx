import { useState } from "react";
import { createRoot } from "react-dom/client";

import { InlineRenameInput } from "../inline-rename";
import "./inline-rename.fixture.css";

const params = new URLSearchParams(location.search);
const rtl = params.get("rtl") === "true";
document.documentElement.dir = rtl ? "rtl" : "ltr";
document.documentElement.lang = rtl ? "ar" : "en";
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);

const Fixture = () => {
  const [value, setValue] = useState(rtl ? "مراجعة العقد" : "Contract review");
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [commits, setCommits] = useState(0);
  const [cancels, setCancels] = useState(0);
  const retain = params.get("retain") === "true";
  const commit = () => {
    setValue(draft);
    if (!retain) {
      setEditing(false);
    }
    setCommits((count) => count + 1);
    setOutcome("committed");
  };
  return (
    <main>
      <header>
        <div
          data-title-container
          data-fallback={params.get("fallback") === "true"}
        >
          {editing ? (
            <InlineRenameInput
              ref={(element) => {
                if (element) {
                  element.dataset["refExposed"] = "true";
                }
              }}
              aria-label="Title"
              value={draft}
              onValueChange={setDraft}
              onCommit={commit}
              onCancel={() => {
                if (!retain) {
                  setEditing(false);
                }
                setCancels((count) => count + 1);
                setOutcome("cancelled");
              }}
            />
          ) : (
            <button
              type="button"
              data-title-view
              onClick={() => {
                setDraft(value);
                setOutcome("");
                setEditing(true);
              }}
            >
              {value}
            </button>
          )}
        </div>
        <button type="button">Outside</button>
      </header>
      <output data-commits={commits} data-cancels={cancels}>
        {outcome}
      </output>
    </main>
  );
};

const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(<Fixture />);
}
