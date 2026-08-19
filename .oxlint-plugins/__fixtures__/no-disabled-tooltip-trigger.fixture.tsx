// Passive regression fixture for
// `no-disabled-tooltip-trigger/no-disabled-tooltip-trigger`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { Button } from "@stll/ui/button";
import { DialogTrigger } from "@stll/ui/dialog";
import { MenuTrigger } from "@stll/ui/menu";
import { TooltipTrigger } from "@stll/ui/tooltip";

import Tooltip from "@/components/tooltip";

const t = (key: string) => key;
const isBusy = false;

// --- Flagged: a disabled Button as the tooltip's render target ---
export const _a = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <Tooltip content={t("save")} render={<Button disabled />} />
);
export const _b = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <Tooltip content={t("save")} render={<Button disabled={isBusy} />} />
);
// Flagged through an intermediate trigger.
export const _c = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <Tooltip
    content={t("save")}
    render={<DialogTrigger render={<Button disabled={isBusy} />} />}
  />
);
// Flagged on the Base UI trigger part too.
export const _d = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <TooltipTrigger render={<Button disabled={isBusy} />} />
);
// Flagged: the Button's own `tooltip` prop does not excuse a second, outer one.
export const _e = () => (
  // oxlint-disable-next-line no-disabled-tooltip-trigger/no-disabled-tooltip-trigger
  <Tooltip
    content={t("save")}
    render={<Button disabled tooltip={t("save")} />}
  />
);

// --- Allowed: the Button owns its tooltip, so it stays reachable ---
export const _ok1 = () => <Button disabled tooltip={t("save")} />;
export const _ok2 = () => <Button disabled={isBusy} tooltip={t("save")} />;
// Allowed: an enabled Button can be hovered, so an outer tooltip works.
export const _ok3 = () => <Tooltip content={t("save")} render={<Button />} />;
// Allowed: the render target is not a Button.
export const _ok4 = () => (
  <Tooltip content={t("save")} render={<MenuTrigger disabled={isBusy} />} />
);
// Allowed: a Base UI trigger part around an enabled Button.
export const _ok5 = () => <TooltipTrigger render={<Button />} />;
