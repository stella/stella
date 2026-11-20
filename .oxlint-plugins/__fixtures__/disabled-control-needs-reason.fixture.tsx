// Passive regression fixture for
// `disabled-control-needs-reason/disabled-control-needs-reason`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { Button } from "@stll/ui/button";

const t = (key: string) => key;
const isEmpty = true;

// --- Flagged: disabled with nothing to say about why ---
export const _a = () => (
  <Button
    // oxlint-disable-next-line disabled-control-needs-reason/disabled-control-needs-reason
    disabled
  >
    {t("send")}
  </Button>
);
export const _b = () => (
  <Button
    // oxlint-disable-next-line disabled-control-needs-reason/disabled-control-needs-reason
    disabled={isEmpty}
    tooltip={t("send")}
  >
    {t("send")}
  </Button>
);

// --- Allowed ---
// expect-clean: disabled-control-needs-reason/disabled-control-needs-reason
export const _c = () => (
  <Button disabled={isEmpty} disabledReason={t("typeFirst")}>
    {t("send")}
  </Button>
);
export const _d = () => <Button disabled={false}>{t("send")}</Button>;
