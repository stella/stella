// Passive regression fixture for
// `no-button-whitespace-normal/no-button-whitespace-normal`.

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";
import { MenuItem as OtherButton } from "@stll/ui/menu";

const wide = true;
const label = "wrapped";

export const _literal = () => (
  // oxlint-disable-next-line no-button-whitespace-normal/no-button-whitespace-normal
  <Button className="whitespace-normal">{label}</Button>
);
export const _cn = () => (
  // oxlint-disable-next-line no-button-whitespace-normal/no-button-whitespace-normal
  <Button className={cn("px-2", "whitespace-normal")} />
);
export const _conditional = () => (
  // oxlint-disable-next-line no-button-whitespace-normal/no-button-whitespace-normal
  <Button className={wide ? "sm:whitespace-normal" : "whitespace-nowrap"} />
);
export const _template = () => (
  // oxlint-disable-next-line no-button-whitespace-normal/no-button-whitespace-normal
  <Button className={`flex ${wide ? "!whitespace-normal" : ""}`} />
);
export const _templateChunk = () => (
  // oxlint-disable-next-line no-button-whitespace-normal/no-button-whitespace-normal
  <Button className={`whitespace-normal ${label}`} />
);
export const _escapedTemplateChunk = () => (
  // oxlint-disable-next-line no-button-whitespace-normal/no-button-whitespace-normal
  <Button className={`whitespace\u002dnormal ${label}`} />
);
export const _responsiveVariant = () => (
  // oxlint-disable-next-line no-button-whitespace-normal/no-button-whitespace-normal
  <Button className="max-sm:whitespace-normal" />
);
export const _importantSuffix = () => (
  // oxlint-disable-next-line no-button-whitespace-normal/no-button-whitespace-normal
  <Button className="whitespace-normal!" />
);

// expect-clean: no-button-whitespace-normal/no-button-whitespace-normal
export const _allowed = () => (
  <>
    <Button layout="wrap">Use the supported row layout</Button>
    <Button className="whitespace-nowrap" />
    <OtherButton className="whitespace-normal" />
    <Button>
      <span className="whitespace-normal">Child text can wrap normally</span>
    </Button>
  </>
);
