// parser-output-unchanged: host-registered public-read IO hook wraps transport calls only; parsed output is unchanged.
import { fetchWithTimeout, type FetchWithTimeoutInit } from "@stll/fetch";

export type PublisherReadIo = {
  fetchStream: (
    target: string | URL,
    init: FetchWithTimeoutInit,
  ) => Promise<Response>;
};

export type PublicReadIoRunner = <T>(
  transport: "publisher",
  fn: (io: PublisherReadIo) => Promise<T>,
) => Promise<T>;

const DEFAULT_PUBLIC_READ_IO: PublicReadIoRunner = async (_transport, fn) =>
  await fn({
    fetchStream: async (target, init) => await fetchWithTimeout(target, init),
  });

let activePublicReadIo: PublicReadIoRunner = DEFAULT_PUBLIC_READ_IO;

export const registerPublicReadIo = (runner: PublicReadIoRunner): void => {
  activePublicReadIo = runner;
};

export const withPublisherReadIo = async <T>(
  fn: (io: PublisherReadIo) => Promise<T>,
): Promise<T> => await activePublicReadIo("publisher", fn);
