import { useState } from "react";
import type { ReactElement } from "react";
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

const empty = params.get("empty") === "true";
const fill = params.get("fill") === "true";
// A short title beside a shrinkable sibling in a row sized to its content,
// the way a breadcrumb lays out a matter name and its number.
const sibling = params.get("sibling") === "true";
const longTitle = rtl ? "مراجعة العقد" : "Contract review";
const initialTitle = sibling ? "003" : longTitle;

const wrapInSiblingRow = (field: ReactElement) =>
  sibling ? (
    <span data-sibling-row>
      <span data-sibling>Test</span>
      {field}
    </span>
  ) : (
    field
  );

const Fixture = () => {
  const [value, setValue] = useState(empty ? "" : initialTitle);
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [commits, setCommits] = useState(0);
  const [cancels, setCancels] = useState(0);
  const retain = params.get("retain") === "true";
  // Lets a test supply a corrected draft the way a parent would, without a
  // native input event.
  Object.assign(window, { setFixtureDraft: setDraft });
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
          {wrapInSiblingRow(
            editing ? (
              <InlineRenameInput
                ref={(element) => {
                  if (element) {
                    element.dataset["refExposed"] = "true";
                  }
                }}
                aria-label="Title"
                fill={fill}
                {...(empty ? { placeholder: "Add reference" } : {})}
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
                {value === "" && empty ? "Add reference" : value}
              </button>
            ),
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
