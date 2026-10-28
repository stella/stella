import { useEffect } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { ScrollArea } from "../scroll-area";

// Each case sits in its own frame, so the cases are independent of the
// viewport and of one another. The cases a scroll area must hold:
// - a flex column bounded only by max-height (a card or dialog sized to its
//   content up to a cap) with a footer after the scroll area, with the area
//   either flexed (`min-h-0 flex-1`) or left at its default classes;
// - the same column with short content, which stays as short as its content;
// - a root bounded by its own max-height, in a parent of auto height;
// - a root of definite height, in a parent of auto height;
// - a root with no bound at all, which is as tall as its content.
const FRAME_CLASS = {
  // A frame of definite height that the card's max-height resolves against.
  // `items-start` keeps the card from stretching to the frame, which would
  // give it a definite height and hide the case.
  bounded: "flex h-[300px] w-64 shrink-0 items-start border border-dashed",
  // A frame of auto height: the scroll area's own classes are its only bound.
  open: "w-64 shrink-0 border border-dashed",
} as const;
const CARD_CLASS = "bg-background flex max-h-full w-full flex-col border";

const Lines = ({ count }: { count: number }) => (
  <ul className="flex flex-col gap-2 p-3 text-sm">
    {Array.from({ length: count }, (_, index) => (
      <li data-line={index + 1} key={index}>
        Line {index + 1}
      </li>
    ))}
  </ul>
);

const Footer = () => (
  <div
    className="bg-background flex shrink-0 border-t p-3"
    data-slot="case-footer"
  >
    <button className="min-h-11 w-full rounded-sm border" type="button">
      Confirm
    </button>
  </div>
);

const Case = ({
  name,
  frame = "bounded",
  children,
}: {
  name: string;
  frame?: keyof typeof FRAME_CLASS;
  children: ReactNode;
}) => (
  <section className={FRAME_CLASS[frame]} data-case={name}>
    {children}
  </section>
);

const ScrollAreaFixture = () => {
  useEffect(() => {
    document.documentElement.dataset["scrollAreaReady"] = "true";
    return () => {
      delete document.documentElement.dataset["scrollAreaReady"];
    };
  }, []);

  return (
    <main className="flex flex-wrap items-start gap-4 p-4">
      <Case name="max-height-column-flexed">
        <div className={CARD_CLASS}>
          <ScrollArea axis="vertical" className="min-h-0 flex-1">
            <Lines count={40} />
          </ScrollArea>
          <Footer />
        </div>
      </Case>
      <Case name="max-height-column-default">
        <div className={CARD_CLASS}>
          <ScrollArea axis="vertical">
            <Lines count={40} />
          </ScrollArea>
          <Footer />
        </div>
      </Case>
      <Case name="max-height-column-short">
        <div className={CARD_CLASS}>
          <ScrollArea axis="vertical" className="min-h-0 flex-1">
            <Lines count={2} />
          </ScrollArea>
          <Footer />
        </div>
      </Case>
      <Case frame="open" name="own-max-height">
        <ScrollArea axis="vertical" className="max-h-40">
          <Lines count={40} />
        </ScrollArea>
      </Case>
      <Case frame="open" name="definite-height">
        <ScrollArea axis="vertical" className="h-40">
          <Lines count={40} />
        </ScrollArea>
      </Case>
      <Case frame="open" name="unbounded">
        <ScrollArea axis="vertical">
          <Lines count={3} />
        </ScrollArea>
      </Case>
    </main>
  );
};

const rootElement = document.querySelector("#root");
if (!rootElement) {
  panic("Missing fixture root");
}

createRoot(rootElement).render(<ScrollAreaFixture />);
