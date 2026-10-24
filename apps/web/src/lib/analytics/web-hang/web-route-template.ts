import { WEB_ROUTE_TEMPLATES } from "@/route-templates.gen";

const escapePattern = (literal: string) =>
  literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const segmentPattern = (segment: string): string => {
  if (segment === "$" || segment === "*") {
    return ".*";
  }
  // TanStack supports both whole-segment params and params with static affixes.
  const tokens = segment.split(/(\{\$[\w]+\}|\$[\w]+)/gu);
  return tokens
    .map((token) =>
      token.startsWith("$") || token.startsWith("{$")
        ? "[^/]+"
        : escapePattern(token),
    )
    .join("");
};

export const createWebRouteTemplateResolver = (
  templates: readonly string[],
) => {
  const routeMatchers = templates
    .map((template) => {
      const normalized = template === "/" ? "" : template.replace(/\/$/u, "");
      const segments = normalized.split("/");
      const staticWeight = segments.reduce(
        (weight, segment) =>
          weight +
          (segment.includes("$") || segment === "*" ? 0 : segment.length),
        0,
      );
      return {
        template,
        staticWeight,
        pattern: new RegExp(
          `^${segments.map(segmentPattern).join("/")}/?$`,
          "u",
        ),
      };
    })
    .toSorted(
      (a, b) =>
        b.staticWeight - a.staticWeight ||
        b.template.length - a.template.length,
    );

  /** Only a generated template or a fixed sentinel can reach telemetry. */
  return (pathname: string) => {
    const path = pathname.split(/[?#]/u).at(0) ?? "";
    return (
      routeMatchers.find(({ pattern }) => pattern.test(path))?.template ??
      "unknown"
    );
  };
};

export const resolveWebRouteTemplate =
  createWebRouteTemplateResolver(WEB_ROUTE_TEMPLATES);
