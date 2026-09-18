---
"@stll/cli": minor
---

Quieter registry drift and two ways to hand a command its input. A diverged
server registry now prints one counted line on stderr, with the tool names
behind `--verbose`, and stays silent for `--help`, `auth` and `compatibility`;
when the drift removed the tool behind the command being run, that is an error
on the command (exit 4) rather than an unknown-command usage failure. A command
whose tool takes a document accepts `--file <path>`, reading the local file into
the tool's own base64 field up to the ceiling that field's schema declares. Every
generated command accepts `--schema`, printing its input JSON schema and exiting.
