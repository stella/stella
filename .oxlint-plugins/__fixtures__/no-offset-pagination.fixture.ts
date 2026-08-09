// Passive regression fixture for `no-offset-pagination/no-offset-pagination`.

declare const t: {
  Integer: () => unknown;
  Number: () => unknown;
  Optional: (schema: unknown) => unknown;
};

// oxlint-disable-next-line no-offset-pagination/no-offset-pagination -- fixture proves a direct request offset schema is rejected
const directOffsetSchema = { offset: t.Integer() };
// oxlint-disable-next-line no-offset-pagination/no-offset-pagination -- fixture proves nested schema wrappers cannot hide an offset
const wrappedOffsetSchema = { offset: t.Optional(t.Number()) };

const cursorSchema = { cursor: t.Optional(t.Number()), limit: t.Integer() };
const runtimeOffset = { offset: 20 };

export { cursorSchema, directOffsetSchema, runtimeOffset, wrappedOffsetSchema };
