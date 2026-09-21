import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { DOCKED_COMPOSER_INSET_START_CLASS } from "@/components/ai-suggestions/composer-geometry";
import { DockedComposer } from "@/components/chat/docked-composer";

// A host that lays a side column beside its text sets the inset variable; the
// composer's column must read it, or the bar centres on the pane again.
test("the docked column starts at the host's inset variable", () => {
  const markup = renderToStaticMarkup(
    <DockedComposer bar={<div data-slot="bar" />} />,
  );

  expect(markup).toContain(DOCKED_COMPOSER_INSET_START_CLASS);
  expect(DOCKED_COMPOSER_INSET_START_CLASS).toContain(
    "var(--docked-composer-inset-start,0px)",
  );
});
