export type PathRule =
  | { readonly type: "exact"; readonly path: `/${string}` }
  | { readonly type: "subtree"; readonly path: `/${string}` };

export type PathMatcher = (pathname: string) => boolean;

const normalizeSubtreeRoot = (path: string): string => {
  let end = path.length;
  while (end > 1 && path.at(end - 1) === "/") {
    end -= 1;
  }
  return path.slice(0, end);
};

const matchesRule = (pathname: string, rule: PathRule): boolean => {
  switch (rule.type) {
    case "exact":
      return pathname === rule.path;
    case "subtree": {
      const subtreeRoot = normalizeSubtreeRoot(rule.path);
      return (
        subtreeRoot === "/" ||
        pathname === subtreeRoot ||
        pathname.startsWith(`${subtreeRoot}/`)
      );
    }
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
