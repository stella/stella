import { cn } from "../lib/utils";

const SKELETON_CLASS_NAME =
  "animate-skeleton rounded-sm [--skeleton-highlight:--alpha(var(--color-white)/64%)] [background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)_var(--color-muted)_0_0/200%_100%_fixed] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]";

const Skeleton = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn(SKELETON_CLASS_NAME, className)}
    data-slot="skeleton"
    {...props}
  />
);

/** Phrasing content for a skeleton inside a paragraph or an inline control. */
const InlineSkeleton = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    className={cn(SKELETON_CLASS_NAME, className)}
    data-slot="skeleton"
    {...props}
  />
);

export { InlineSkeleton, Skeleton };
