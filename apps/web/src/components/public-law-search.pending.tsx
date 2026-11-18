import type { ComponentProps, ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { AiActionIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";

// The public-law box's frame and its loading face. A route's pending view
// draws the face while the page loads; the page's box is the same frame and
// the same field, so the box does not move when the page arrives.

/**
 * The box's form. A form so Enter submits the way the browser already knows
 * how to; centred, wider and taller, because a results screen has nothing
 * above the list but this.
 */
export const PublicLawSearchFrame = ({
  children,
  onSubmit,
}: {
  children: ReactNode;
  /** Submitted; the face omits it, so Enter there does nothing. */
  onSubmit?: (() => void) | undefined;
}) => (
  <Form
    className="mx-auto max-w-2xl flex-wrap justify-center"
    density="compact"
    layout="inline"
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit?.();
    }}
    role="search"
  >
    {children}
  </Form>
);

/** The box's one field, at the size the box leads its page with. */
export const PublicLawSearchInput = (
  props: Omit<ComponentProps<typeof Input>, "className" | "type">,
) => (
  <Input
    {...props}
    className="h-11 min-h-11 min-w-64 flex-1 text-base"
    type="search"
  />
);

/**
 * The entry the address carries (`?q=`), read without the route's API so a
 * loading view can show it while the page that owns the box loads.
 */
export const useAddressSearchEntry = (): string =>
  useSearch({
    strict: false,
    select: (search) => (typeof search.q === "string" ? search.q : ""),
  });

/**
 * The box before its page is there: the same field, named and with its
 * placeholder, holding the entry the address carries. The page reads and
 * owns the entry; the face shows it read-only until the page is there.
 */
export const PublicLawSearchFace = ({
  maxLength,
  placeholder,
  refine = false,
  searchLabel,
}: {
  maxLength: number;
  placeholder: string;
  /** Whether the box offers the AI rewrite, whose wand then waits beside it. */
  refine?: boolean | undefined;
  searchLabel: string;
}) => {
  const entry = useAddressSearchEntry();
  return (
    <PublicLawSearchFrame>
      <PublicLawSearchInput
        aria-label={searchLabel}
        maxLength={maxLength}
        placeholder={placeholder}
        readOnly
        value={entry}
      />
      {refine && <PublicLawRefineFace />}
    </PublicLawSearchFrame>
  );
};

/**
 * The wand beside an empty box: there is nothing to rewrite yet, so it waits
 * disabled, as the live wand does over an empty entry.
 */
const PublicLawRefineFace = () => {
  const t = useTranslations();

  return (
    <Button
      aria-label={t("search.aiRefine")}
      disabled
      size="icon-sm"
      title={t("search.aiRefine")}
      type="button"
      variant="muted"
    >
      <AiActionIcon aria-hidden="true" className="size-4" />
    </Button>
  );
};
