import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { publishDocumentPanelInset } from "../../lib/panel-inset";
import { OutlineRail, type OutlineItem } from "../outline-rail";

const presentation = (() => {
  const value = new URLSearchParams(window.location.search).get("presentation");
  return value === "panel" || value === "rail" ? value : "popover";
})();

const items: OutlineItem[] = Array.from({ length: 64 }, (_, index) => ({
  id: `heading-${index + 1}`,
  label: index % 3 === 0 ? `Section ${index + 1}` : `§ ${index + 1}`,
  title: `Long heading title for the synthetic legal provision ${index + 1}, covering jurisdiction, filing requirements, and the supporting record`,
  level: index % 4 === 0 ? 1 : 2,
  meta: String(Math.floor(index / 8) + 1),
}));

const OutlineRailFixture = () => {
  const documentRef = useRef<HTMLDivElement>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerMounted, setComposerMounted] = useState(true);

  useEffect(() => {
    document.documentElement.dataset["outlineRailReady"] = "true";
    return () => {
      delete document.documentElement.dataset["outlineRailReady"];
    };
  }, []);

  return (
    <main data-outline-fixture data-presentation={presentation}>
      <div data-outline-document ref={documentRef}>
        <h1>Motion for protective order</h1>
        <p>Document content gives the outline a real scroll target.</p>
        <div style={{ height: 1800 }} />
      </div>
      <aside aria-label="Document outline host" data-outline-host>
        {presentation !== "popover" && (
          <div data-outline-toggle data-testid="host-toggle">
            Document outline
          </div>
        )}
        <OutlineRail
          ariaLabel="Document outline"
          formatMetaLabel={(page) => `Page ${page}`}
          items={items}
          onJump={() => undefined}
          presentation={presentation}
          resolvePct={(id) => {
            const index = items.findIndex((item) => item.id === id);
            return (index / (items.length - 1)) * 100;
          }}
          scrollContainerRef={documentRef}
          header={
            <div data-testid="outline-header">
              <strong>Contents</strong>
              <p>Jump to a heading in this document.</p>
            </div>
          }
        />
      </aside>
      {composerMounted && (
        <div
          data-outline-composer
          data-expanded={composerExpanded}
          data-testid="composer"
          ref={publishDocumentPanelInset}
        >
          <span>Composer</span>
          <button
            data-testid="resize-composer"
            onClick={() => setComposerExpanded((expanded) => !expanded)}
            type="button"
          >
            Resize composer
          </button>
          <button
            data-testid="remove-composer"
            onClick={() => setComposerMounted(false)}
            type="button"
          >
            Remove composer
          </button>
        </div>
      )}
    </main>
  );
};

const root = document.querySelector("#root");
if (!root) {
  panic("Missing fixture root");
}

createRoot(root).render(<OutlineRailFixture />);
