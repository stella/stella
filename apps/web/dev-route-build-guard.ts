import { panic } from "better-result";
import type { Plugin } from "vite";

export const assertNoDevRouteModules = (moduleIds: Iterable<string>) => {
  for (const id of moduleIds) {
    if (/[/\\]src[/\\]routes[/\\]dev(?:[/\\]|\.tsx(?:\?|$))/u.test(id)) {
      panic(`Production bundle contains a dev visual module: ${id}`);
    }
  }
};

// Guard both client and server outputs, including lazy playground chunks.
export const devRouteBuildGuard = (): Plugin => ({
  name: "stella-dev-route-build-guard",
  apply: "build",
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type === "chunk") {
        assertNoDevRouteModules(Object.keys(output.modules));
      }
    }
  },
});
