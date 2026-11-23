import type { ReactNode } from "react";

/**
 * A correspondence envelope's card: its fields in as many columns as fit
 * the card's own width (one in a narrow inspector), whatever the viewport.
 * A child spanning the card (its heading, a closing note) takes
 * `col-span-full`.
 */
export const EnvelopeCard = ({ children }: { children: ReactNode }) => (
  <section
    className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4 rounded-lg border p-4"
    data-slot="envelope-card"
  >
    {children}
  </section>
);

/**
 * One labeled value of a correspondence envelope. Values wrap anywhere, so
 * an unbroken token (a certified mailbox address, a message id) narrows to
 * its column instead of running past the card.
 */
export const EnvelopeField = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className="min-w-0 space-y-1">
    <div className="text-muted-foreground text-xs">{label}</div>
    <div
      className="min-w-0 text-sm wrap-anywhere"
      data-slot="envelope-field-value"
    >
      {children}
    </div>
  </div>
);
