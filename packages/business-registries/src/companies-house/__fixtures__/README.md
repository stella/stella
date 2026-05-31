# Companies House fixtures

Captured live from the Companies House public data API via HTTP Basic
auth (the operator-controlled key never appears in this repository).
The captured slices are trimmed to ≤5 items where the upstream is
paginated, so they stay readable in PR diffs.

Endpoints captured:

- `GET /company/00445790` — Tesco PLC (active).
- `GET /company/02557590` — ARM Limited (active, with previous-name
  history).
- `GET /company/05956860` — Phones 4U Direct Limited (dissolved
  2015-05-05) — exercises the `dissolved` status arm.
- `GET /company/99999999` → 404 — documents the error envelope so the
  upstream-message parser has something to read; Companies House
  sends a JSON body for missing resources rather than an empty 404.
- `GET /company/00445790/officers` — officers roster (top 5 by
  upstream order; metadata trimmed to match for self-consistency).
- `GET /search/companies?q=Tesco` — name search (top 5).

To re-capture, set `COMPANIES_HOUSE_API_KEY` in `apps/api/.env` and
re-run the requests with HTTP Basic auth — the API key is the
username, the password is empty. Any standard HTTP client works
(curl, httpie, fetch).
