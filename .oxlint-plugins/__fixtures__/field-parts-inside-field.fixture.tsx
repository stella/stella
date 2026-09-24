// Passive regression fixture for
// `field-parts-inside-field/field-parts-inside-field`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { DialogPopup } from "@stll/ui/dialog";
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldItem,
  FieldLabel,
  FieldValidity,
} from "@stll/ui/field";
import { Input } from "@stll/ui/input";

const t = (key: string) => key;

// --- Flagged: a part in plain markup, with no `Field` above it ---
export const ReferenceRow = () => (
  <section className="grid">
    <Input />
    {/* oxlint-disable-next-line field-parts-inside-field/field-parts-inside-field */}
    <FieldDescription>{t("workspaces.referenceHint")}</FieldDescription>
  </section>
);
export const NameRow = () => (
  <div>
    {/* oxlint-disable-next-line field-parts-inside-field/field-parts-inside-field */}
    <FieldLabel>{t("common.name")}</FieldLabel>
    {/* oxlint-disable-next-line field-parts-inside-field/field-parts-inside-field */}
    <FieldControl render={<Input />} />
  </div>
);
export const StandaloneItem = () => (
  <div>
    {/* oxlint-disable-next-line field-parts-inside-field/field-parts-inside-field */}
    <FieldItem>
      <Input />
    </FieldItem>
  </div>
);
// Flagged: the part sits beside the `Field`, not inside it.
export const ErrorBesideField = () => (
  <div>
    <Field>
      <FieldLabel>{t("common.name")}</FieldLabel>
    </Field>
    {/* oxlint-disable-next-line field-parts-inside-field/field-parts-inside-field */}
    <FieldError />
  </div>
);
// Flagged: the local component between the part and the markup renders no
// `Field` of its own, and nothing mounts the owner inside one.
export const ValidityRow = () => (
  <PlainRow>
    {/* oxlint-disable-next-line field-parts-inside-field/field-parts-inside-field */}
    <FieldValidity>{() => null}</FieldValidity>
  </PlainRow>
);
const PlainRow = ({ children }: { children: React.ReactNode }) => (
  <div className="flex">{children}</div>
);

// --- Allowed: the part has a `Field` ancestor ---
export const LabelledInput = () => (
  <Field>
    {/* expect-clean: field-parts-inside-field/field-parts-inside-field */}
    <FieldLabel>{t("common.name")}</FieldLabel>
    <FieldControl render={<Input />} />
    <FieldDescription>{t("common.hint")}</FieldDescription>
    <FieldError />
  </Field>
);
// Allowed: any depth of host markup between the root and the part.
export const NestedMarkup = () => (
  <Field>
    <div className="grid">
      <section>
        <FieldLabel>{t("common.name")}</FieldLabel>
      </section>
    </div>
  </Field>
);
// Allowed: a local wrapper that renders a `Field` of its own.
export const WrappedDescription = () => (
  <LocalFieldRow>
    <FieldDescription>{t("common.hint")}</FieldDescription>
  </LocalFieldRow>
);
const LocalFieldRow = ({ children }: { children: React.ReactNode }) => (
  <Field>{children}</Field>
);
// Allowed: the owner's own markup carries no root, but this file mounts it
// inside a `Field`.
const LookupRow = () => (
  <div className="flex">
    <FieldControl render={<Input />} />
  </div>
);
export const LookupFormats = () => (
  <Field>
    <FieldLabel>{t("common.name")}</FieldLabel>
    <LookupRow />
  </Field>
);
// Allowed, unproven: the wrapper's body lives in another module, so the walk
// stops there rather than guessing.
export const PopupError = () => (
  <DialogPopup>
    <FieldError />
  </DialogPopup>
);
// Allowed, unproven: a part held in a variable has no JSX element above it,
// so where it is mounted is not readable here.
export const HeldInVariable = () => {
  const label = <FieldLabel>{t("common.name")}</FieldLabel>;
  return <Field>{label}</Field>;
};
