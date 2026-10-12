import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, staticStringValue } from "./utils.ts";

export default eslintCompatPlugin({
  meta: { name: "no-ambient-dev-docker" },
  rules: {
    "no-ambient-dev-docker": {
      meta: {
        type: "problem",
        messages: {
          direct:
            "Construct development Docker commands through dev-docker so the endpoint and captured environment stay pinned together.",
        },
      },
      createOnce(context) {
        let scoped = false;
        return {
          before() {
            const filename = filenameForContext(context);
            scoped =
              filename.endsWith(
                "/.oxlint-plugins/__fixtures__/no-ambient-dev-docker.fixture.ts",
              ) ||
              (/\/packages\/scripts\/src\/(?:dev-[^/]+|agent-session)\.ts$/u.test(
                filename,
              ) &&
                !filename.endsWith(".test.ts") &&
                !filename.endsWith("/dev-docker.ts"));
          },
          TemplateLiteral(node) {
            const value = staticStringValue(node);
            if (
              scoped &&
              value !== null &&
              /(?:^|[/\\])docker(?:\.exe)?$/u.test(value)
            ) {
              context.report({ node, messageId: "direct" });
            }
          },
          Literal(node) {
            if (
              scoped &&
              typeof node.value === "string" &&
              /(?:^|[/\\])docker(?:\.exe)?$/u.test(node.value)
            ) {
              context.report({ node, messageId: "direct" });
            }
          },
        };
      },
    },
  },
});
