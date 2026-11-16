// Passive regression fixture for `no-adhoc-outcome-screen/no-adhoc-outcome-screen`.

import { Button } from "@stll/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FrameTitle,
} from "@stll/ui/frame";
import { OutcomeScreen } from "@stll/ui/outcome-screen";

// oxlint-disable-next-line no-adhoc-outcome-screen/no-adhoc-outcome-screen
export const handWrittenPage = `<!doctype html><html><body><h1>Signed in</h1></body></html>`;

export const closeByHand = () => {
  // oxlint-disable-next-line no-adhoc-outcome-screen/no-adhoc-outcome-screen
  window.close();
};

export const HandBuiltCard = () => (
  // oxlint-disable-next-line no-adhoc-outcome-screen/no-adhoc-outcome-screen
  <Frame>
    <FrameHeader>
      <FrameTitle>Agent connected</FrameTitle>
      <FrameDescription>You can return to your agent.</FrameDescription>
    </FrameHeader>
  </Frame>
);

export const HandBuiltStatus = () => (
  // oxlint-disable-next-line no-adhoc-outcome-screen/no-adhoc-outcome-screen
  <div role="status">
    <h1>Connected</h1>
  </div>
);

// expect-clean: no-adhoc-outcome-screen/no-adhoc-outcome-screen
export const Outcome = () => (
  <OutcomeScreen
    actions={<Button>Go to matters</Button>}
    closeTab={{ onStillOpen: () => undefined }}
    title="Invitation declined"
    tone="success"
  />
);

export const SettingsCard = () => (
  <Frame>
    <FrameHeader>
      <FrameTitle>Sessions</FrameTitle>
    </FrameHeader>
    <input aria-label="Name" />
  </Frame>
);

export const htmlMention = "The editor writes its value on <html>.";
