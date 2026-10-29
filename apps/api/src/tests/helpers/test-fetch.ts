// The test preload captures this before asynchronous test module evaluation can
// overlap with another file's mocked request.
export const testFetch = globalThis.fetch;
