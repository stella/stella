# Redact complete values before shortening output, including literal metacharacters.
reduce ([env.JOURNEY_DETAIL_CREDENTIAL, env.STELLA_API_KEY, env.GITHUB_TOKEN,
         env.GH_TOKEN, env.JOURNEY_DETAIL_SESSION][] | select(. != null and . != "")) as $secret
  (.; split($secret) | join("[REDACTED]"))
| gsub("(?i)bearer[ \\t]+[^\\s\"'<>]+"; "Bearer [REDACTED]")
| gsub("(?i)(?:api[_ -]?key|key|access[_-]?token|refresh[_-]?token|token|authorization)[\\\"']?[ \\t]*[:=][ \\t]*[\\\"']?[^\\s\"'&,;<>]+"; "credential=[REDACTED]")
| split("\n")[0]
| gsub("[\\x00-\\x1f\\x7f-\\x9f]"; " ")
| .[0:400]
