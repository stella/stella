import { QueryObserver, useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { expectTypeOf } from "bun:test";

import { queryView } from "./query-view.logic";
import type { QueryView } from "./query-view.logic";
import { createAppQueryClient } from "./react-query";

const useInlineQueryView = () => {
  const view = queryView(
    useQuery({
      queryKey: ["query-view", "inference"],
      queryFn: async () => await Promise.resolve({ body: "Revision" }),
    }),
  );
  if (view.type === "items") {
    expectTypeOf(view.items).toEqualTypeOf<{ body: string }>();
  }
  if (view.type === "error") {
    expectTypeOf(view.error).toEqualTypeOf<Error>();
  }
  return view;
};

expectTypeOf(useInlineQueryView).returns.toEqualTypeOf<
  QueryView<{ body: string }, Error>
>();

const observerQueryView = () => {
  const observer = new QueryObserver(createAppQueryClient(), {
    queryKey: ["query-view", "observer-inference"],
    queryFn: async () => await Promise.resolve({ body: "Revision" }),
    enabled: false,
  });
  return queryView(observer.getCurrentResult());
};

expectTypeOf(observerQueryView).returns.toEqualTypeOf<
  QueryView<{ body: string }, Error>
>();

const structuralQueryView = () =>
  queryView({
    status: "error",
    fetchStatus: "idle",
    isPlaceholderData: false,
    data: { body: "Cached revision" },
    error: new Error("Read failed"),
    refetch: async () => {
      await Promise.resolve();
      return panic("Type fixture refetch must not execute");
    },
  });

expectTypeOf(structuralQueryView).returns.toEqualTypeOf<
  QueryView<{ body: string }, Error>
>();
