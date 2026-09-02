// Allow CSS custom properties (`--*`) on React's CSSProperties.
//
// React's typings do not include custom-property keys, so any
// `style={{ "--sidebar-width": "..." }}` would otherwise require an
// `as CSSProperties` / `as CSSWithVars` cast at the JSX boundary. This
// module augmentation surfaces the names natively so consumers can pass
// CSS variables without a cast.
//
// Package-local (rather than the app's shared `types/` root) so this
// package's own type-check does not reach outside its published boundary.
//
// `interface` is required here: declaration merging only works with
// interfaces, not type aliases.

import "react";

declare module "react" {
  interface CSSProperties {
    [cssVar: `--${string}`]: string | number | undefined;
  }
}
