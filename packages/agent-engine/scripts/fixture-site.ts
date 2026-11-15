import { panic } from "better-result";
import { createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Base64 } from "@stll/sha256/node";

import { FIXTURE_CANARIES, FIXTURE_CITATION } from "./fake-browser";

/**
 * The fixture library as a real browser sees it: HTML pages over HTTPS,
 * for the stella browser's end-to-end test. The same site as the fake
 * extension's (`fake-browser.ts`), with a decision long enough to need
 * more than one reading window, headings to outline, a sign-in page and a
 * probe page that prints what the page can observe about the browser.
 *
 * The browser reaches it under a public-looking name that its host
 * resolver maps to this server; the name is reserved for examples, so
 * nothing resolves it outside the test.
 */

const FIXTURE_SITE_HOST = "library.example.com";

/** Phrases the scenario finds; each paragraph that holds one says so. */
const FIXTURE_FIND_QUERY = "notice period";

/** The decision's paragraphs, and the ones that hold the canaries. */
const PARAGRAPHS = 160;
const FIRST_CANARY_PARAGRAPH = 2;
const SECOND_CANARY_PARAGRAPH = 150;
const FIND_PARAGRAPHS = new Set([3, 61, 62, 145]);

const SECTIONS = [
  { from: 1, heading: "I. Facts" },
  { from: 41, heading: "II. Reasoning" },
  { from: 60, heading: "Notice period", level: 3 },
  { from: 140, heading: "III. Holding" },
] as const;

const FILLER =
  "The record shows the correspondence between the parties, the dates on which each letter was sent and received, and the steps the claimant took before the action was brought. Nothing in the file suggests that either party relied on another arrangement, and the court sees no reason to read the agreement otherwise than by its plain words.";

const paragraph = (number: number): string => {
  const parts = [`[${String(number)}]`, FILLER];
  if (number === FIRST_CANARY_PARAGRAPH) {
    parts.push(`${FIXTURE_CANARIES[0]} is recorded in the file.`);
  }
  if (FIND_PARAGRAPHS.has(number)) {
    parts.push(
      `The ${FIXTURE_FIND_QUERY} runs from delivery, not from dispatch.`,
    );
  }
  if (number === SECOND_CANARY_PARAGRAPH) {
    parts.push(`The claimant, ${FIXTURE_CANARIES[1]}, lost the appeal.`);
  }
  return `<p>${parts.join(" ")}</p>`;
};

const decisionBody = (): string => {
  const blocks: string[] = [
    `<nav><a href="/">Library</a></nav><h1>${FIXTURE_CITATION.title}</h1>`,
  ];
  for (let number = 1; number <= PARAGRAPHS; number += 1) {
    const section = SECTIONS.find(({ from }) => from === number);
    if (section !== undefined) {
      const level = "level" in section ? section.level : 2;
      blocks.push(`<h${String(level)}>${section.heading}</h${String(level)}>`);
    }
    blocks.push(paragraph(number));
  }
  blocks.push('<p><a href="/">Back to the library</a></p>');
  return blocks.join("\n");
};

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

/** What the member's account page shows once they signed in. */
export const FIXTURE_SIGNED_IN = {
  title: "Your account",
  text: "Signed in to the fixture library.",
} as const;

/**
 * The sign-in page asks the site whether the member signed in, as a page
 * waiting on another device's confirmation does, and loads again once
 * they have.
 */
const SIGN_IN_WAIT =
  '<script>setInterval(async () => { const state = await fetch("/account/state").then((answer) => answer.text()); if (state === "signed-in") { location.reload(); } }, 250);</script>';

/** Each page by path; `null` when there is none. */
const fixtureHtml = (url: URL, signedIn: boolean): string | null => {
  switch (url.pathname) {
    case "/":
      return page(
        "Fixture library",
        '<h1>Fixture library</h1><form action="/search"><input type="search" name="q" aria-label="Search"><button>Search</button></form>',
      );
    case "/search": {
      const query = url.searchParams.get("q") ?? "";
      const escaped = query.replaceAll(/[<>&"]/gu, "");
      return page(
        `Results for ${escaped}`,
        `<h1>Results for ${escaped}</h1><ul><li><a href="${FIXTURE_CITATION.path}">${FIXTURE_CITATION.title}</a></li><li><a href="/doc/7-t-89-2023">Decision 7 T 89/2023</a></li></ul>`,
      );
    }
    case FIXTURE_CITATION.path:
      return page(
        FIXTURE_CITATION.title,
        decisionBody(),
        `<link rel="canonical" href="${FIXTURE_CITATION.path}">`,
      );
    case "/account":
      return signedIn
        ? page(
            FIXTURE_SIGNED_IN.title,
            `<h1>${FIXTURE_SIGNED_IN.title}</h1><p>${FIXTURE_SIGNED_IN.text}</p>`,
          )
        : page(
            "Sign in",
            `<h1>Sign in</h1><form><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form>${SIGN_IN_WAIT}`,
          );
    case "/probe":
      // What a page can see of the browser that runs it.
      return page(
        "Probe",
        '<h1>Probe</h1><p id="webdriver"></p><script>document.getElementById("webdriver").textContent = "webdriver: " + String(navigator.webdriver);</script>',
      );
    default:
      return null;
  }
};

/** A self-signed certificate for the site's name, and the hash the browser is told to accept. */
const certificate = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stella-fixture-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const made = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "2",
      "-subj",
      `/CN=${FIXTURE_SITE_HOST}`,
      "-addext",
      `subjectAltName=DNS:${FIXTURE_SITE_HOST}`,
    ],
    { stderr: "ignore", stdout: "ignore" },
  );
  if (made.exitCode !== 0) {
    rmSync(dir, { force: true, recursive: true });
    return panic("openssl could not make the fixture certificate");
  }
  const pems = {
    cert: readFileSync(cert, "utf-8"),
    key: readFileSync(key, "utf-8"),
  };
  rmSync(dir, { force: true, recursive: true });
  const spki = createPublicKey(pems.cert).export({
    format: "der",
    type: "spki",
  });
  return {
    ...pems,
    spki: sha256Base64(spki),
  };
};

/** The site, served over HTTPS on a loopback port. */
export const startFixtureSite = () => {
  const tls = certificate();
  const account = { signedIn: false, signedInViews: 0 };
  const server = Bun.serve({
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/account/state") {
        return new Response(account.signedIn ? "signed-in" : "signed-out", {
          headers: { "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/account" && account.signedIn) {
        account.signedInViews += 1;
      }
      const html = fixtureHtml(url, account.signedIn);
      return html === null
        ? new Response(null, { status: 404 })
        : new Response(html, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
    },
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: tls.cert, key: tls.key },
  });
  const port = server.port ?? 0;
  return {
    /** The address the browser opens. */
    origin: `https://${FIXTURE_SITE_HOST}`,
    /** Where the browser's resolver sends the site's name; nothing else resolves. */
    hostRules: `MAP ${FIXTURE_SITE_HOST} 127.0.0.1:${String(port)}, MAP * ~NOTFOUND`,
    spki: tls.spki,
    /** The member signs in, as they would in the window the run showed them. */
    signIn: () => {
      account.signedIn = true;
    },
    /** How often the account page was served to a signed-in member. */
    signedInViews: () => account.signedInViews,
    stop: async () => {
      await server.stop(true);
    },
  };
};
