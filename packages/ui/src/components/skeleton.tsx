import { cn } from "../lib/utils";

const SKELETON_CLASS =
  "animate-skeleton rounded-sm [--skeleton-highlight:--alpha(var(--color-white)/64%)] [background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)_var(--color-muted)_0_0/200%_100%_fixed] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]";

const Skeleton = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn(SKELETON_CLASS, className)}
    data-slot="skeleton"
    {...props}
  />
);

/**
 * A skeleton bar inside a line of text (a paragraph, a heading, a label): a
 * span, so it may stand where only phrasing content is allowed. A `div` in a
 * `<p>` is closed out of the paragraph by the HTML parser, and the server's
 * markup then no longer matches what hydration renders.
 */
const SkeletonInline = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    className={cn("inline-block", SKELETON_CLASS, className)}
    data-slot="skeleton"
    {...props}
  />
);

export { Skeleton, SkeletonInline };
