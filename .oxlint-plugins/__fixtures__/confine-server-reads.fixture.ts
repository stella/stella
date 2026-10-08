/* oxlint-disable no-duplicate-imports, import/no-duplicates -- fixture imports independent cases */

// Passive fixture for `confine-server-reads/confine-server-reads`.

// oxlint-disable-next-line confine-server-reads/confine-server-reads -- named access
import { getRequestHeader as readHeader } from "@tanstack/react-start/server";
// oxlint-disable-next-line confine-server-reads/confine-server-reads -- named access
import { getCookie as readCookie } from "@tanstack/react-start/server";
// oxlint-disable-next-line confine-server-reads/confine-server-reads -- named access
import { getRequest } from "@tanstack/react-start/server";
import * as server from "@tanstack/react-start/server";
// expect-clean: confine-server-reads/confine-server-reads
import { getRequestHost } from "@tanstack/react-start/server";

// oxlint-disable-next-line confine-server-reads/confine-server-reads -- namespace access
const requestHeaders = server.getRequestHeaders();

const requestHost = getRequestHost();
const header = readHeader("accept-language");
const cookie = readCookie("locale");
const request = getRequest();

export { cookie, header, request, requestHeaders, requestHost };
