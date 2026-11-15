// The threaded WebAssembly matchers allocate shared memory as soon as their
// module loads, which a page may do only when it is cross-origin isolated.
// Safari does not honour the credentialless embedder policy and the desktop
// webview is never isolated, so on those pages the threaded module throws on
// import and takes the importing route down with it. Such pages load the
// single-thread build instead, which needs no shared memory.

type LoadWasmBuildOptions<T> = {
  isolated: boolean;
  threaded: () => Promise<T>;
  singleThread: () => Promise<T>;
};

export const loadWasmBuild = async <T>({
  isolated,
  threaded,
  singleThread,
}: LoadWasmBuildOptions<T>): Promise<T> =>
  await (isolated ? threaded() : singleThread());
