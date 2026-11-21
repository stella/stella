import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { PlusIcon } from "../../icons";
import { Button, BUTTON_CONTENT, BUTTON_SIZE_CONTENT } from "../button";
import { Popover, PopoverPanel, PopoverTrigger } from "../popover";

type ButtonSize = keyof typeof BUTTON_SIZE_CONTENT;

const SIZES = Object.keys(BUTTON_SIZE_CONTENT).filter(
  (size): size is ButtonSize => size in BUTTON_SIZE_CONTENT,
);

// One popover per button size. Each popup focuses its first row on open, the
// way an outline or a picker does. A text row is named by an `aria-label` that
// differs from what it shows; an icon row is named by its label alone. The
// trigger, too, shows text and carries a differing label.
const SizeRow = ({ size }: { size: ButtonSize }) => {
  const content = BUTTON_SIZE_CONTENT[size];
  return (
    <section data-content={content} data-size={size}>
      <Popover>
        <PopoverTrigger
          aria-label={`Open the ${size} outline`}
          render={<Button size="sm" />}
        >
          Outline {size}
        </PopoverTrigger>
        <PopoverPanel align="start">
          {content === BUTTON_CONTENT.icon ? (
            <Button aria-label={`Add a ${size} section`} size={size}>
              <PlusIcon />
            </Button>
          ) : (
            <Button aria-label={`Go to the ${size} reasoning`} size={size}>
              Reasoning
            </Button>
          )}
          <Button size="sm">Second row</Button>
        </PopoverPanel>
      </Popover>
    </section>
  );
};

const ButtonTooltipFixture = () => (
  <main className="flex flex-col items-start gap-2 p-4">
    {SIZES.map((size) => (
      <SizeRow key={size} size={size} />
    ))}
  </main>
);

const root = document.querySelector("#root");
if (root === null) {
  panic("Missing button tooltip fixture root");
}
createRoot(root).render(<ButtonTooltipFixture />);
