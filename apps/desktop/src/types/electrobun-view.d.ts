declare module "electrobun/view" {
  type RequestSchema<TParams, TResponse> = {
    params: TParams;
    response: TResponse;
  };

  type RequestClient<
    TRequests extends Record<string, RequestSchema<unknown, unknown>>,
  > = {
    [TKey in keyof TRequests]: (
      params: TRequests[TKey]["params"],
    ) => Promise<TRequests[TKey]["response"]>;
  };

  type RpcClient<TRpc> = TRpc extends {
    bun: {
      requests: infer TRequests extends Record<
        string,
        RequestSchema<unknown, unknown>
      >;
    };
    webview: {
      messages: infer TMessages extends Record<string, unknown>;
    };
  }
    ? {
        request: RequestClient<TRequests>;
        send: {
          [TKey in keyof TMessages]: (payload: TMessages[TKey]) => void;
        };
      }
    : unknown;

  export class Electroview<TRpc = unknown> {
    public constructor(options: { rpc: unknown });
    public static defineRPC<T>(config: unknown): unknown;
    public rpc: RpcClient<TRpc>;
  }
}
