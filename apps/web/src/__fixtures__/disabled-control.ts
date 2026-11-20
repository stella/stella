// A `Button` is disabled in one of two forms: natively (`disabled`), or, when
// it carries a tooltip or must keep focus, accessibly (`aria-disabled`), which
// stays hoverable while its activation is blocked. A test that reads only the
// native attribute misses the second form, and a "not disabled" wait on it
// passes before the control is usable.
export const isDisabledControl = (control: HTMLElement): boolean =>
  control.hasAttribute("disabled") ||
  control.getAttribute("aria-disabled") === "true";
