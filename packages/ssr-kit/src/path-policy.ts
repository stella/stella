export type PathRule =
  | { readonly type: "exact"; readonly path: `/${string}` }
  | { readonly type: "subtree"; readonly path: `/${string}` };

export type PathMatcher = (pathname: string) => boolean;

const matchesRule = (pathname: string, rule: PathRule): boolean => {
  switch (rule.type) {
    case "exact":
      return pathname === rule.path;
    case "subtree":
      return pathname === rule.path || pathname.startsWith(`${rule.path}/`);
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
};

export const createPathMatcher =
  (rules: readonly PathRule[]): PathMatcher =>
  (pathname) =>
    rules.some((rule) => matchesRule(pathname, rule));
