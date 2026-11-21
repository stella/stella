import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports a disabled Button with no reason",
    source: "const view = <Button disabled />;",
    lines: [1],
  },
  {
    title: "reports an expression-disabled Button with no reason",
    source: "const view = <Button\n  disabled={isEmpty}\n>Send</Button>;",
    lines: [2],
  },
  {
    title: "a tooltip alone is not a reason",
    source: 'const view = <Button disabled={busy} tooltip="Send" />;',
    lines: [1],
  },
  {
    title: "allows a disabled Button that says why",
    source:
      'const view = <Button disabled={isEmpty} disabledReason={t("chat.sendPromptEmpty")} />;',
    lines: [],
  },
  {
    title: "allows a never-disabled Button and other controls",
    source:
      "const view = <><Button disabled={false} /><Button /><MenuItem disabled /></>;",
    lines: [],
  },
];

test.each(cases)(
  "disabled-control-needs-reason: $title",
  async ({ source, lines }) => {
    expect(
      (
        await runSingleRule("disabled-control-needs-reason", source, {
          sourcePath: "source.tsx",
        })
      ).lines,
    ).toEqual(lines);
  },
);
