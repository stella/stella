import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isStringLiteral } from "./utils.ts";

/**
 * CloudFront's viewer headers are trustworthy only on a request that proved it
 * came through CloudFront (the origin secret); anyone reaching the API another
 * way can send them with any value. Their names live in two owners: the client
 * address resolver, which honours the viewer address header only behind that
 * proof, and the viewer location reader, which reads the geolocation headers
 * only when the address was resolved that way.
 *
 * Flags any string or template literal naming a `cloudfront-viewer-*` header,
 * in any case. Syntax only: a name assembled from fragments that do not
 * themselves start with the prefix is out of reach.
 */
const VIEWER_HEADER_OWNERS = [
  "apps/api/src/lib/client-ip.ts",
  "apps/api/src/lib/auth/viewer-location.ts",
] as const;

const VIEWER_HEADER = /^cloudfront-viewer-/iu;

export default eslintCompatPlugin({
  meta: { name: "no-raw-cloudfront-viewer-header" },
  rules: {
    "no-raw-cloudfront-viewer-header": {
      meta: {
        type: "problem",
        messages: {
          rawHeader:
            "Read CloudFront viewer headers through readViewerLocation (apps/api/src/lib/auth/viewer-location.ts) or the client address resolver, which honour them only on a request that proved it came through CloudFront.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return !VIEWER_HEADER_OWNERS.some((owner) =>
              filename.endsWith(owner),
            );
          },
          Literal(node) {
            if (isStringLiteral(node) && VIEWER_HEADER.test(node.value)) {
              context.report({ node, messageId: "rawHeader" });
            }
          },
          TemplateLiteral(node) {
            if (
              node.quasis.some((quasi) => VIEWER_HEADER.test(quasi.value.raw))
            ) {
              context.report({ node, messageId: "rawHeader" });
            }
          },
        };
      },
    },
  },
});
