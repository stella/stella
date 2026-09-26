# Stella browser extension

Chrome-only Manifest V3 extension for approved browser actions from stella chat.
It uses the current Chrome profile, so a controlled tab shares the user's normal
signed-in website sessions. The extension does not expose cookies, raw HTML,
downloads, or arbitrary JavaScript.

## Local installation

1. Run `bun --filter @stll/extension build`. Against a local stella dev
   server, run `bun --filter @stll/extension build:dev` instead.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select `apps/extension/.output/chrome-mv3` (or `chrome-mv3-dev`).
4. Open a stella app tab, then open the extension popup.
5. Choose **Allow all websites**, then **Connect current stella tab**.
6. Refresh the stella tab once after installing a new extension build.

## Trust boundary

The bridge content script runs only on the configured stella origins. The
default list is the hosted stella origins; a self-hosted deployment sets
`WXT_STELLA_ORIGINS` at build time to a comma-separated list of exact HTTPS
origins:

```bash
WXT_STELLA_ORIGINS=https://stella.example.org bun --filter @stll/extension build
```

Only development builds (`dev`, `build:dev`) and the Playwright build also
trust `http://localhost` and `http://127.0.0.1`; `build` checks that the
release manifest grants nothing on loopback or plain HTTP.

The popup binds one explicit tab and exact origin as the active controller.
Website access is optional, HTTPS only, and requested in a user gesture
together with two optional permissions, and browser commands refuse to run
without all three:

- `downloads` cancels downloads a controlled page starts (see below);
- `webNavigation` tells which page opened a new tab, which navigations only
  the browser's interface starts, and which frames each tab holds, so a
  page-opened tab stays confined and a download is traced to its frame.

`activeTab` lets the popup read the URL of the stella tab it was opened on
when pairing.

Chat reads the controlled tab. That tab is either one stella opened through
`open`, or a tab the user already has open: open the popup on that page and
choose **Use this tab with stella**, then ask about it in chat.

## Control and stopping

The extension's background worker runs browser commands one at a time, and
pairing, **Use this tab with stella**, disconnecting and removing website
access go through the same queue. Each of those ends the command that is
running or waiting; Stop in chat ends the stopped turn's command and never a
command of a later turn. A waiting command never reaches the page, and a
running one returns at once. An action that was
already handed to the page is reported as `outcome-unknown`, because it may
have taken effect. Stop does not undo what already happened, sign anyone out,
or close tabs.

Every command names the tab and page snapshot chat last saw. Element actions
run only in the exact document their snapshot read, and `open` and `go-back`
only while Chrome reports the tab still shows the document chat last read
successfully (a stopped or failed read does not count). When Chrome cannot say
what the tab shows, or chat has read nothing in it, they are refused; after a
navigation, a reload or a tab the user handed over, they are refused until
chat reads the page again. There is no exception for error pages: Chrome
offers no documented signal that tells its error page apart from a page chat
never saw. When the tab shows a page chat cannot read, chat asks the user to
open a page in it, or to hand over another tab from the popup. Each chat turn may run 40 actions including 15
navigations, and each pairing 400 actions including 150 navigations; page
reads, and commands refused before they act, are not counted. Reconnecting
from the popup starts a new pairing.

When the controller re-pairs or disconnects, or the user hands chat another
tab, the web app forgets the per-session choice to auto-approve page reads.

## What the controlled tab can reach

The controlled tab may only load public HTTPS pages, and never stella itself.
While a tab is controlled, network rules scoped to it block every request,
including pages, frames, scripts, images, `fetch`, beacons and WebSockets, to
plain HTTP or `ws:`, embedded credentials, IPv6 literals, IPv4 literals in
loopback, private, link-local or reserved ranges, single-label names,
`.local`/`.localhost`/`.internal` hosts and the stella origins, whether the
request comes from `open`, a click, a form post, a redirect or the page's own
script. Snapshots skip frames outside this policy, and actions refuse them.
The rules are lifted when control ends.

While any tab is controlled, the rules cover every tab except those known to
be the user's, so a new tab is confined from its first request until there is
evidence of who opened it. A tab is the user's when it was open before control
started, when Chrome reports that one of the user's pages opened it, or when
it shows a page only the browser's own interface can open: an address typed
into the address bar, a bookmark, a keyword search or the New Tab page. Time
alone is never evidence. A tab a controlled page opens (`window.open`,
`target=_blank`, from any frame), or a tab still unsorted opens, stays
confined and open for the user even if that report arrives late or the user
types into it; chat never operates it, and one a controlled page opened whose
first address is a non-public HTTPS host is closed. A tab chat operated before
the user handed it another stays confined until control ends or it closes.

So while a tab is controlled, open stella or an intranet page from a new tab
or an existing tab of your own. A link one of your pages opens in a new tab
can be blocked on its first load, before Chrome reports its source; reloading
it works. A tab opened another way (a link from another app, a bookmark
opened into a new tab) that goes straight to a blocked address stays blocked;
open that address from a new tab instead.

Downloads are blocked: attachment responses and responses Chrome would save
instead of display are blocked in the network, and downloads a controlled page
or any of its frames starts from script (`blob:` or `data:` URLs) are
cancelled. Chrome does not say which tab started a download, so while a tab is
controlled every download is traced by origin to the frames open at that
moment:

- one only the user's tabs account for goes through;
- any other is cancelled: one a confined tab's frame could have started, one
  either side could have started (the user has the same site open), and one
  nothing accounts for (a `data:` download without a referring page, a frame
  already gone, or frames Chrome could not list).

Chrome holds each download until the extension has judged it, so a stopped
download writes no file. The extension never deletes a file: tracing by
origin samples the frames open at one moment and cannot prove who started a
download. A download that finished before it could be judged, which happens
only when Chrome skips that step, stays on disk and is flagged instead.

The toolbar icon counts downloads stopped and finished files kept, and the
popup names both counts once, warning about kept files to check before
opening them.

## Limits

- The rules judge the host name, not what it resolves to: a public name whose
  DNS answer is a private address is not blocked.
- A page response without a `Content-Type` header is not blocked in the
  network: the rules have no condition on status codes, so a rule for a
  missing header would also block redirects and cache revalidations. Chrome
  treats such a response as a download when it cannot display it, and the
  download is then cancelled as above.
- Requests that belong to no tab are not covered by the rules. A controlled
  page's service worker makes its requests outside any tab, so it can reach
  an address the page itself cannot; confining those would break the user's
  own sites' workers as well.
- The tab uses the user's real Chrome profile and signed-in sessions. An
  approved click can use anything those sessions allow, including payment
  methods a site has saved.
- Scripts on an allowed site see what is typed into that site, including values
  chat fills in, and can show a password anywhere: the extension withholds a
  secret field's value wherever the same page shows it again (see below), but
  not one shorter than 4 characters, one shown encoded or split up, one shown
  after the page navigates, or one typed into a field inside a shadow root
  and then moved without an edit event.

## Snapshots

Snapshots never include the values of password, payment-card or one-time-code
fields, or of text masked with `-webkit-text-security`, and chat cannot fill or
choose them. A field stays in that group for the life of its page once it has
been one, so a "show password" toggle does not make its value readable, and
fields whose name or id has a word such as `password`, `otp` or `cvc` count as
well. The values of those fields are remembered for the life of the page,
from the first time chat reads it: as the user or the page types, when a
field stops being a password field, and when one is removed. A field or text
that holds one, such as a new field a "show password" button put in the old
one's place, is withheld or shown as `[hidden]`.

Snapshots leave out text and controls a reader of the page cannot see: hidden
from assistive technology (`aria-hidden`), transparent, invisible, clipped
away, collapsed to a pixel, off the page, or in zero-size or transparent type.

Snapshots read every frame and open shadow root, return interactive elements
with their link destinations, and page the visible text; long pages are read in
slices through `snapshot` with `textOffset`.

Each browser command is approved in stella chat. The user may choose, per web
session, to auto-approve page reads; every other command always asks.

WXT is pinned and used only as the build shell. Runtime messaging, permissions,
storage, and scripting use standard Chrome APIs and a stella-owned versioned
protocol.
