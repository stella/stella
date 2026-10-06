import * as v from "valibot";

/** Three physical scan rounds: omissions first, then one eligible id each. */
export const installCorpusDispositionScan = (ids: readonly string[]) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = v.parse(
        v.record(v.string(), v.unknown()),
        await new Response(init?.body).json(),
      );
      if (body["snippet_fields"] !== undefined) {
        return Response.json({ num_hits: 0, hits: [], snippets: [] });
      }
      const offset = v.parse(v.number(), body["start_offset"]);
      const roundIds = ids.slice(offset, offset === 0 ? 2 : offset + 1);
      return Response.json({
        num_hits: ids.length,
        hits: roundIds.map((id) => ({ document_id: id })),
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  return () => {
    globalThis.fetch = originalFetch;
  };
};
