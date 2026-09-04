import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { DirectionProvider } from "@base-ui/react";
import { EllipsisVertical } from "lucide-react";

import { WorkspaceViewSwitcher } from "../../../../workspace-ui/src/view-switcher";
import { InspectorContent, InspectorRailContent } from "../../inspector";

const WorkspaceViewSwitcherFixture = () => {
  const query = new URLSearchParams(window.location.search);
  const direction = query.has("rtl") ? "rtl" : "ltr";
  const dark = query.has("dark");
  const views = direction === "rtl" ? RTL_VIEWS : LTR_VIEWS;
  const [activeViewId, setActiveViewId] = useState("table");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.dataset["workspaceViewSwitcherReady"] = "true";
    return () => {
      document.documentElement.classList.remove("dark");
      delete document.documentElement.dataset["workspaceViewSwitcherReady"];
    };
  }, [dark]);

  const actionsLabel = direction === "rtl" ? "الإجراءات" : "Actions";
  const addViewLabel = direction === "rtl" ? "إضافة عرض" : "Add view";

  return (
    <DirectionProvider direction={direction}>
      <main className="flex flex-col gap-4 p-4">
        <div className="w-[640px]" data-workspace-switcher>
          <WorkspaceViewSwitcher
            activeViewId={activeViewId}
            addControl={<button type="button">{addViewLabel}</button>}
            ariaLabel={direction === "rtl" ? "العروض المحفوظة" : "Saved views"}
            direction={direction}
            onViewChange={setActiveViewId}
            renderActions={(view) =>
              view.id === activeViewId ? (
                <button
                  aria-label={`${actionsLabel} ${view.name}`}
                  className="size-5"
                  type="button"
                >
                  <EllipsisVertical aria-hidden size={16} />
                </button>
              ) : null
            }
            renderIcon={() => null}
            reorder={null}
            views={views}
          />
        </div>
        <div className="flex h-20 w-[640px]" data-inspector-scrollbars>
          <InspectorRailContent>
            {Array.from({ length: 4 }, (_, index) => (
              <span className="block h-12 shrink-0" key={index}>
                Rail item {index + 1}
              </span>
            ))}
          </InspectorRailContent>
          <InspectorContent>
            {Array.from({ length: 4 }, (_, index) => (
              <span className="block h-12 shrink-0" key={index}>
                Content item {index + 1}
              </span>
            ))}
          </InspectorContent>
        </div>
      </main>
    </DirectionProvider>
  );
};

const LTR_VIEWS = [
  { id: "table", name: "All matters", kind: "table" },
  { id: "calendar", name: "Deadlines", kind: "calendar" },
];

const RTL_VIEWS = [
  { id: "table", name: "كل القضايا", kind: "table" },
  { id: "calendar", name: "المواعيد النهائية", kind: "calendar" },
];

const root = document.querySelector("#root");

if (root) {
  createRoot(root).render(<WorkspaceViewSwitcherFixture />);
}
