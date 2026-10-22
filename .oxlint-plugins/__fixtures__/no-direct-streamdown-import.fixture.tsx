/* oxlint-disable import/no-duplicates, unicorn/prefer-module -- fixture: each import form stands on its own line */

// Passive regression fixture for
// `no-direct-streamdown-import/no-direct-streamdown-import`.
//
// Untrusted chat content renders through MessageResponse
// (apps/web/src/components/ai-elements/message-response.tsx), the only module
// that imports streamdown or its `@streamdown/*` plugins.

// oxlint-disable-next-line no-direct-streamdown-import/no-direct-streamdown-import -- a plugin package
import { math } from "@streamdown/math";
// oxlint-disable-next-line no-direct-streamdown-import/no-direct-streamdown-import -- a named import
import { Streamdown } from "streamdown";
// oxlint-disable-next-line no-direct-streamdown-import/no-direct-streamdown-import -- a type-only import
import type { Components } from "streamdown";

// expect-clean: no-direct-streamdown-import/no-direct-streamdown-import
import { MessageResponse } from "@/components/ai-elements/message";

// oxlint-disable-next-line no-direct-streamdown-import/no-direct-streamdown-import -- a dynamic import
const pendingRenderer = import("streamdown");
// oxlint-disable-next-line no-direct-streamdown-import/no-direct-streamdown-import -- require
const requiredRenderer = require("streamdown").Streamdown;

// oxlint-disable-next-line no-direct-streamdown-import/no-direct-streamdown-import -- a re-export
export { defaultComponents } from "streamdown";

const components: Components = {};

export const DirectStreamdownImportFixture = () => (
  <>
    <Streamdown components={components} plugins={{ math }}>
      text
    </Streamdown>
    <MessageResponse>text</MessageResponse>
  </>
);

export { pendingRenderer, requiredRenderer };
