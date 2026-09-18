import { useEffect } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { Popover, PopoverPanel, PopoverTrigger } from "../popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../select";
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

// A select has no `side` of its own to request: it opens with the chosen item
// over the trigger, and Base UI abandons that mode when the trigger is within
// 20px of the top or bottom edge. The edge cases pin one trigger to each edge
// so the fallback placement has room on one side only.
const EDGE_SELECT_SIZES = ["25", "50", "100"] as const;
const EDGE_SELECT_LABEL = {
  top: "Page size at top edge",
  bottom: "Page size at bottom edge",
} as const;

const EdgeSelect = ({ edge }: { edge: keyof typeof EDGE_SELECT_LABEL }) => (
  <Select defaultValue="50">
    <SelectTrigger
      aria-label={EDGE_SELECT_LABEL[edge]}
      className={
        edge === "top"
          ? "fixed start-2 top-1 w-24"
          : "fixed start-2 bottom-1 w-24"
      }
      size="sm"
    >
      <SelectValue />
    </SelectTrigger>
    <SelectPopup>
      {EDGE_SELECT_SIZES.map((size) => (
        <SelectItem key={size} value={size}>
          {size}
        </SelectItem>
      ))}
    </SelectPopup>
  </Select>
);

const AnchoredPopupFixture = () => {
  useEffect(() => {
    document.documentElement.dataset["anchoredPopupReady"] = "true";
    return () => {
      delete document.documentElement.dataset["anchoredPopupReady"];
    };
  }, []);

  return (
    <main className="flex min-h-dvh flex-col items-end justify-center gap-8 p-2">
      <EdgeSelect edge="top" />
      <EdgeSelect edge="bottom" />
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
