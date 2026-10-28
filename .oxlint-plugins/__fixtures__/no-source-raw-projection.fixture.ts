declare const record: Record<string, unknown>;
declare const encodeSourceRawEnvelope: (parts: Record<string, string>) => string;
declare const omit: (record: Record<string, unknown>, keys: string[]) => Record<string, unknown>;

// oxlint-disable-next-line no-source-raw-projection/no-source-raw-projection -- fixture: publisher fields cannot be filtered at the raw sink
const filtered = { sourceRaw: JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => key !== "newField"))) };
// oxlint-disable-next-line no-source-raw-projection/no-source-raw-projection -- fixture: an envelope cannot hide a field projection
const envelope = encodeSourceRawEnvelope({ record: JSON.stringify(omit(record, ["newField"])) });
const complete = { sourceRaw: JSON.stringify(record) };

export { filtered, envelope, complete };
