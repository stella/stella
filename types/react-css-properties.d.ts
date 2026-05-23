// Allow CSS custom properties (`--*`) on React's CSSProperties.
//
// React's typings do not include custom-property keys, so any
// `style={{ "--sidebar-width": "..." }}` would otherwise require an
// `as CSSProperties` / `as CSSWithVars` cast at the JSX boundary. This
// module augmentation surfaces the names natively so consumers can
// pass CSS variables without a cast.
//
// `interface` is required here: declaration merging only works with
// interfaces, not type aliases.
/* oxlint-disable typescript/consistent-type-definitions */

import "react";

declare module "react" {
  type CSSProperties = Record<`--${string}`, string | number | undefined>;
}
