Captured from the publisher on 2026-10-28 for ECLI:CZ:NSS:2017:5.As.140.2014.76.

- Detail: `https://vyhledavac.nssoud.cz/DokumentDetail/Index/641220`.
- Placeholder: `/DokumentOriginal/Html/641220` and `/DokumentOriginal/Text/641220` both served the same BOM-less UTF-16LE HTML containing `N/A`. The fixture is decoded to UTF-8 with LF line endings; its HTTP fixture restores CRLF and the original encoding.
- Registry: `https://www.nssoud.cz/rozhodovaci-cinnost/rozsireny-senat?filter[fileNumber_type]=referral&filter[fileNumber]=5+As+140%2F2014&showResults=1`.
- Original: the registry's exact `5 As 140/2014 - 76` link, `/modalni-obsah/rozhodovaci-cinnost/rozhodnuti-225964-anonymizovana-verze?cHash=6bc215d9ce30ec53bf5f607b19e3e74e`, served the PDF verbatim (`application/pdf`, 232661 bytes).

The registry also links the referral, `5 As 140/2014 - 53`; it must not replace the resolution. The adapter discovers the original through the complete reference rather than a stored document ID or filename. The main portal's `/DokumentOriginal/Index/641220` returned HTTP 500 during capture; the registry original remained available.
