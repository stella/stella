# Refreshing CLDR exemplar inputs

`refresh-cldr-exemplars.yml` runs Unicode's official CLDR 49 converter on the
immutable release source and publishes a reviewed input artifact. It does not
change the dependency catalog or generated application data.

CLDR 49's npm data omits locales below Basic coverage. The advertised
`cldr-exemplars-delta-49.zip` currently has the same 3,490 payload entries as
`cldr-common-49.zip`; it cannot restore those locales. The full release source
retains their XML files. This refresh resolves that same release's source with
the official converter, including inheritance and the contributed draft
threshold. No earlier release's character data is copied.

The pinned source archive, official converter JAR and npm archive are recorded
with SHA-256 digests in `cldr49-input.json`. The JAR identifies the same source
commit in its manifest. The refresh verifies every digest before extraction or
execution, bounds Java to two processors and 3 GiB, and compares the converted
character membership with every primary npm locale. Existing supported locale
identifiers define the coverage requirement; their old character values are not
used. The current migration requires 292 primary plus 93 supplemental locales,
385 in total.

Run the **Refresh CLDR exemplar input** workflow, or use an empty directory on a
build machine with Bun, Java 21, curl, jq, unzip, tar and sha256sum:

```sh
CLDR_JAVA=/path/to/java21/bin/java \
  bash packages/mojibake/scripts/refresh-exemplar-input.sh /tmp/cldr49-input
```

The `cldr49-exemplar-input` artifact contains the supplemental raw UnicodeSets,
their SHA-256 digest, all primary/supplemental locale identifiers, source and
converter provenance, and the upstream license. A missing locale, changed
primary character set, malformed UnicodeSet, hash mismatch or converter error
fails the refresh. Review the artifact before committing it as a build input and
upgrading the catalog. Normal application extraction must remain offline.

Sources:

- [CLDR 49 release notes](https://cldr.unicode.org/downloads/cldr-49)
- [Pinned CLDR source](https://github.com/unicode-org/cldr/tree/96e54b273d2da4ec6fbad350ba19ff23fa24a588)
- [Official JSON generation options](https://github.com/unicode-org/cldr-json/blob/49.0.0/cldr-generate-json.sh)

The committed `data/cldr49/` supplement was produced by the official converter
in run 40651680324 at a35772b9934. It contains 93 supplemental locales;
292 npm locales plus those 93 preserve 385 locales. Every npm locale's
normalized exemplar membership matched the same-release resolved source.
The offline extractor verifies the supplement digest, release and exact
primary/supplemental coverage before generating the table. A future CLDR
upgrade must refresh this input and provenance together.
