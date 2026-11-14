import { panic } from "better-result";
import { connect } from "node:net";

import type { HttpApp } from "@/api/http/app";

export type OneWriteRequest = {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
  /** How the body is framed on the wire; `content-length` by default. */
  readonly framing?: "content-length" | "chunked";
};

export type ServedResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
};

const CRLF = "\r\n";

const frame = ({
  method = "POST",
  path,
  headers = {},
  body,
  framing = "content-length",
}: OneWriteRequest): Buffer => {
  const bytes = Buffer.from(body, "utf-8");
  const head = [
    `${method} ${path} HTTP/1.1`,
    "Host: localhost",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    framing === "chunked"
      ? "Transfer-Encoding: chunked"
      : `Content-Length: ${bytes.byteLength}`,
    "Connection: close",
    "",
    "",
  ].join(CRLF);
  return Buffer.concat([
    Buffer.from(head, "latin1"),
    ...(framing === "chunked"
      ? [
          Buffer.from(`${bytes.byteLength.toString(16)}${CRLF}`, "latin1"),
          bytes,
          Buffer.from(`${CRLF}0${CRLF}${CRLF}`, "latin1"),
        ]
      : [bytes]),
  ]);
};

const decodeChunked = (body: Buffer): Buffer => {
  const parts: Buffer[] = [];
  let offset = 0;
  while (true) {
    const lineEnd = body.indexOf(CRLF, offset);
    const size =
      lineEnd === -1
        ? 0
        : Number.parseInt(
            body.subarray(offset, lineEnd).toString("latin1"),
            16,
          );
    if (!(size > 0)) {
      return Buffer.concat(parts);
    }
    const start = lineEnd + CRLF.length;
    parts.push(body.subarray(start, start + size));
    offset = start + size + CRLF.length;
  }
};

const parseResponse = (raw: Buffer): ServedResponse => {
  const separator = raw.indexOf(`${CRLF}${CRLF}`);
  if (separator === -1) {
    return panic(
      `The served request closed without a complete response: ${raw.toString("utf-8")}`,
    );
  }
  const [statusLine = "", ...lines] = raw
    .subarray(0, separator)
    .toString("latin1")
    .split(CRLF);
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const rawBody = raw.subarray(separator + 2 * CRLF.length);
  return {
    status: Number(statusLine.split(" ")[1]),
    headers,
    body: (/chunked/iu.test(headers.get("transfer-encoding") ?? "")
      ? decodeChunked(rawBody)
      : rawBody
    ).toString("utf-8"),
  };
};

/**
 * Serve `app` with the production `Bun.serve` routing on an ephemeral IPv4
 * loopback port and send one request whose headers and body leave in ONE
 * socket write, the way a load balancer forwards a small request. The body
 * has then fully arrived before the route touches it, which Bun's own fetch
 * (headers and body written separately) and in-process requests never
 * exercise. Answers the status, headers and body; the server is stopped.
 */
export const sendServedRequest = async (
  app: HttpApp,
  request: OneWriteRequest,
): Promise<ServedResponse> => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...app.serveOptions,
  });
  try {
    const port = server.port;
    if (port === undefined) {
      return panic("The served request's server did not bind a port");
    }
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("error", reject);
    socket.on("close", () => {
      resolve(Buffer.concat(chunks));
    });
    socket.write(frame(request));
    return parseResponse(await promise);
  } finally {
    await server.stop(true);
  }
};
