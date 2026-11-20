import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Button } from "@stll/ui/button";

import {
  InboxProviderText,
  InboxQuickJumpLayout,
} from "./inbox-quick-jump-face";

export { PROVIDERS, PROVIDER_ICON_URLS } from "./inbox-quick-jump-face";

export const InboxQuickJump = ({ email }: { email: string }) => (
  <InboxQuickJumpLayout
    email={email}
    renderProvider={({ name, url }, icon) => (
      <Button
        key={name}
        render={
          <a href={sanitizeHref(url)} rel="noopener noreferrer" target="_blank">
            {icon}
            <InboxProviderText name={name} />
          </a>
        }
        size="sm"
        variant="ghost"
      />
    )}
  />
);
