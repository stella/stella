import * as v from "valibot";

const readerInstanceSchema = v.strictObject({
  sequence: v.pipe(v.number(), v.safeInteger()),
  instance: v.pipe(v.string(), v.uuid()),
});
type ReaderInstance = v.InferOutput<typeof readerInstanceSchema>;

export const isNewerReaderInstance = (
  own: ReaderInstance,
  payload: unknown,
) => {
  const parsed = v.safeParse(readerInstanceSchema, payload);
  if (!parsed.success) {
    return false;
  }
  const received = parsed.output;
  return (
    received.sequence > own.sequence ||
    (received.sequence === own.sequence && received.instance > own.instance)
  );
};

type ReaderSupersessionOptions = {
  channel: {
    send: (message: ReaderInstance) => void;
    subscribe: (listener: (payload: unknown) => void) => () => void;
    close: () => void;
  };
  identity: ReaderInstance;
  supersede: () => void;
};
export const connectReaderSupersession = ({
  channel,
  identity,
  supersede,
}: ReaderSupersessionOptions) => {
  let lifecycle: "active" | "superseded" | "closed" = "active";
  const unsubscribe = channel.subscribe((payload) => {
    if (lifecycle !== "active" || !isNewerReaderInstance(identity, payload)) {
      return;
    }
    lifecycle = "superseded";
    supersede();
  });
  channel.send(identity);
  return () => {
    if (lifecycle === "closed") {
      return;
    }
    lifecycle = "closed";
    unsubscribe();
    channel.close();
  };
};
