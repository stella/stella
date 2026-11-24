# Fixtures

`law-firm.pst` is written by the package's PST assembler
(`src/assemble/`, test and fixture builds only) from `fixtures::law_firm`:
invented correspondence of an invented law firm (every name, firm and number
is made up; addresses use the reserved `.example` domain). It is a Unicode
PST with nested folders; plain, HTML and RTF bodies; attachments; an attached
message; a message without a subject; text in several scripts; and a message
whose list row claims more than a message may be.

The assembler follows [MS-PST] and shares no code with the reader, so the
fixture checks the reader against the specification. `cargo test` fails when
the committed file differs from the assembler's output; regenerate it with
`bun run fixtures`.

`outlook-pst-rs/Empty.pst` is a third-party fixture; see its README.
