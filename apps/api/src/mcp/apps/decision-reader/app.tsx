import { createRoot } from "react-dom/client";

import { panic, Result } from "better-result";

import { createReaderController } from "./controller";
import { connectReaderSupersession } from "./supersession";
import { ReaderView } from "./view";

const controller = createReaderController();
const root = document.querySelector("#app");
if (root === null) {
  panic("Decision reader app mount is missing");
}
createRoot(root).render(<ReaderView host={controller} />);
controller.bridge.detached(
  controller.bridge.connect(),
  "connect decision reader",
);

// Repeated tool openings retain earlier app instances in some hosts.
const supersession = Result.try(() => {
  const identity = {
    sequence: Math.floor(performance.timeOrigin + performance.now()),
    instance: crypto.randomUUID(),
  };
  const channel = new BroadcastChannel("stella-decision-reader");
  return { identity, channel };
});
if (Result.isOk(supersession)) {
  const { identity, channel } = supersession.value;
  const dispose = connectReaderSupersession({
    identity,
    supersede: controller.supersede,
    channel: {
      send: channel.postMessage.bind(channel),
      subscribe: (listener) => {
        const receive = ({ data }: MessageEvent<unknown>) => listener(data);
        channel.addEventListener("message", receive);
        return () => {
          channel.removeEventListener("message", receive);
        };
      },
      close: () => channel.close(),
    },
  });
  window.addEventListener("pagehide", dispose, { once: true });
}
