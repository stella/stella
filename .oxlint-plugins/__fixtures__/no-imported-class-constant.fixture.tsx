// Passive regression fixture for
// `no-imported-class-constant/no-imported-class-constant`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { Button as KitButton } from "@stll/ui-kit/button";
import { Button } from "@stll/ui/button";
import { SHELL_CHROME_LAYER_CLASS_NAME } from "@stll/ui/lib/overlay-layer";
import { cn } from "@stll/ui/utils";

const LOCAL_ROW_CLASS_NAME = "mt-2 w-full";

const LocalPanel = (props: { className?: string }) => <div {...props} />;

// --- Flagged: the class string is opaque to shadcn/no-restyle ---
export const _a = () => (
  // oxlint-disable-next-line no-imported-class-constant/no-imported-class-constant
  <Button className={SHELL_CHROME_LAYER_CLASS_NAME} />
);

// --- Flagged: an imported identifier among several cn() arguments ---
export const _b = ({ active }: { active: boolean }) => (
  <Button
    className={cn(
      "mt-2",
      // oxlint-disable-next-line no-imported-class-constant/no-imported-class-constant
      SHELL_CHROME_LAYER_CLASS_NAME,
      active && "w-full",
    )}
  />
);

// --- Accepted: a constant declared here, which the design-system rule reads ---
export const _ok1 = () => <Button className={LOCAL_ROW_CLASS_NAME} />;
export const _ok2 = () => (
  <Button className={cn("mt-2", LOCAL_ROW_CLASS_NAME)} />
);
// Accepted: classes written where they are used.
export const _ok3 = () => <Button className="mt-2" />;
// Accepted: an intrinsic element is not a design-system component.
export const _ok4 = () => <div className={SHELL_CHROME_LAYER_CLASS_NAME} />;
// Accepted: a component from outside @stll/ui owns its own class contract.
export const _ok5 = () => (
  <LocalPanel className={SHELL_CHROME_LAYER_CLASS_NAME} />
);
// Accepted: a neighbouring package whose name merely starts the same way is
// not the design system.
export const _ok5b = () => (
  <KitButton className={SHELL_CHROME_LAYER_CLASS_NAME} />
);
// Accepted: the className prop forwarded on; a parameter, not an import.
export const _ok6 = ({ className }: { className?: string }) => (
  <Button className={className} />
);
// Accepted: a prop spelled like the imported constant shadows it, so the
// value resolves to the parameter and the classes are the caller's.
export const _ok7 = ({
  // oxlint-disable-next-line eslint/no-shadow -- the shadow is the case under test: the rule must resolve the binding, not the spelling
  SHELL_CHROME_LAYER_CLASS_NAME,
}: {
  SHELL_CHROME_LAYER_CLASS_NAME: string;
}) => <Button className={SHELL_CHROME_LAYER_CLASS_NAME} />;
// Accepted: a local that shadows the import inside the component body.
export const _ok8 = () => {
  // oxlint-disable-next-line eslint/no-shadow -- same shadow, declared as a local rather than a parameter
  const SHELL_CHROME_LAYER_CLASS_NAME = "mt-2";
  return <Button className={cn("w-full", SHELL_CHROME_LAYER_CLASS_NAME)} />;
};
