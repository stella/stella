// A disabled control must say why it cannot act.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { disabledAttributeWithoutReason } from "./disabled-control-needs-reason.logic.ts";
import { filenameForContext } from "./utils.ts";

export default eslintCompatPlugin({
  meta: { name: "disabled-control-needs-reason" },
  rules: {
    "disabled-control-needs-reason": {
      meta: {
        type: "suggestion",
        messages: {
          missingReason:
            'A disabled Button must say why it cannot act. Pass `disabledReason` ("Type a message to send it."): it becomes the tooltip while disabled and keeps the button hoverable and focusable.',
        },
      },
      createOnce(context) {
        return {
          before() {
            return filenameForContext(context).endsWith(".tsx");
          },
          JSXOpeningElement(node) {
            const index = disabledAttributeWithoutReason(node);
            const attribute =
              index === null ? undefined : node.attributes[index];
            if (attribute === undefined) {
              return;
            }
            context.report({ node: attribute, messageId: "missingReason" });
          },
        };
      },
    },
  },
});
