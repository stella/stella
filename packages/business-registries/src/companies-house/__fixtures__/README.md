# Companies House fixtures

These fixtures are **docs-derived shape stand-ins**, not live captures.
They were authored from the official Companies House API reference
(<https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/>)
and the public api-enumerations bundle, with realistic identifiers for
well-known UK companies.

Replace with live captures once a `COMPANIES_HOUSE_API_KEY` is
available. The API authenticates via HTTP Basic with the key as
username and empty password; export the key and re-run the requests
listed below (the operator-controlled key never appears in this
repository).

Endpoints to capture:

- `GET /company/00445790` — well-known company hit (Tesco PLC).
- `GET /company/02557590` — well-known company hit (ARM Holdings).
- `GET /search/companies?q=Tesco&items_per_page=5` — name search.
- `GET /company/00445790/officers` — officers roster.

The `company-missing.json` fixture documents the error envelope returned
on 404 — Companies House sends a JSON body for missing resources rather
than an empty 404, so the upstream-message parser has something to read.
