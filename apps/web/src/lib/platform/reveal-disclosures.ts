/**
 * Unfolds every disclosure that hides `target`, so it can be focused,
 * highlighted or scrolled to: native `<details>` and panels kept in the page
 * as `hidden="until-found"` (the @stll/ui Collapsible and Accordion default).
 * A hidden-until-found panel opens the way find-in-page opens it, with
 * `beforematch` and then the attribute removed, so the component that owns
 * the panel records the open state. Works inside same-origin frames too.
 */
export const revealEnclosingDisclosures = (target: Element): void => {
  for (
    let element: Element | null = target;
    element !== null;
    element = element.parentElement
  ) {
    if (element.localName === "details") {
      element.setAttribute("open", "");
      continue;
    }
    if (element.getAttribute("hidden") === "until-found") {
      element.dispatchEvent(new Event("beforematch"));
      element.removeAttribute("hidden");
    }
  }
};
