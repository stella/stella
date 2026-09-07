import { useEffect } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { Popover, PopoverPanel, PopoverTrigger } from "../popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../tooltip";

// Both triggers span 432px at the inline end of a 1280px viewport, and both
// popups are wider than the 216px between the trigger's centre and the edge:
// a popup centred on its trigger fits only once collision handling shifts it
// back, and collision handling only sees a positioner that measures its popup.
// `side` comes from the query string so one page covers every side, including
// the two on which Base UI takes the popup out of normal flow.
const SIDES = ["top", "bottom", "left", "right"] as const;

type Side = (typeof SIDES)[number];

const isSide = (value: string | null): value is Side =>
  SIDES.some((side) => side === value);

const sideParam = new URLSearchParams(window.location.search).get("side");
const side: Side = isSide(sideParam) ? sideParam : "top";

const AnchoredPopupFixture = () => {
  useEffect(() => {
    document.documentElement.dataset["anchoredPopupReady"] = "true";
    return () => {
      delete document.documentElement.dataset["anchoredPopupReady"];
    };
  }, []);

  return (
    <main className="flex min-h-dvh flex-col items-end justify-center gap-8 p-2">
      <Tooltip>
        <TooltipTrigger render={<span className="block w-108 text-end" />}>
          Version row
        </TooltipTrigger>
        <TooltipPopup side={side}>
          <span className="block w-80">Full timestamp</span>
        </TooltipPopup>
      </Tooltip>
      <Popover>
        <PopoverTrigger className="w-108">Open</PopoverTrigger>
        <PopoverPanel side={side}>
          <p className="w-80">Wide popover content</p>
        </PopoverPanel>
      </Popover>
    </main>
  );
};

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}

createRoot(rootElement).render(<AnchoredPopupFixture />);
