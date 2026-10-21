import * as v from "valibot";

/** Three physical scan rounds: omissions first, then one eligible id each. */
export const installCorpusDispositionScan = (
  hits: readonly { id: string; revision: string }[],
) => {
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
      const roundHits = hits.slice(offset, offset === 0 ? 2 : offset + 1);
      return Response.json({
        num_hits: hits.length,
        hits: roundHits.map(({ id, revision }) => ({
          document_id: id,
          projection_revision: revision,
        })),
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  return () => {
    globalThis.fetch = originalFetch;
  };
};

type RevisionPassage = {
  id: string;
  revision: string;
  text: string;
};

/** Query matching and scores come from passage content, including stale copies. */
export const installCorpusRevisionScan = (
  passages: readonly RevisionPassage[],
) => {
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
      const scored = body["from"] !== undefined;
      const query = scored
        ? v.parse(
            v.object({ query_string: v.object({ query: v.string() }) }),
            body["query"],
          ).query_string.query
        : v.parse(v.string(), body["query"]);
      const term = query.replace("text:", "");
      const matches = passages
        .map(({ id, revision, text }, index) => ({
          fields: {
            document_id: id,
            projection_revision: revision,
            chunk_id: `passage-${String(index)}`,
            text,
          },
          score: text.split(/\s+/u).filter((word) => word === term).length,
        }))
        .filter(({ score }) => score > 0)
        .toSorted((a, b) => b.score - a.score);
      const offset = v.parse(
        v.number(),
        scored ? body["from"] : body["start_offset"],
      );
      if (scored) {
        return Response.json({
          hits: {
            total: { value: matches.length },
            hits: matches.slice(offset).map(({ fields, score }) => ({
              _source: fields,
              _score: score,
            })),
          },
        });
      }
      return Response.json({
        num_hits: matches.length,
        hits: matches.slice(offset).map(({ fields }) => fields),
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  return () => {
    globalThis.fetch = originalFetch;
  };
};
