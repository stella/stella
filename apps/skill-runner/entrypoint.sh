#!/bin/sh
# The runner needs no AWS credentials: it moves archives through presigned
# URLs and logs to stdout. Start the Lambda runtime without them, so no
# process a skill's command can read holds them. The handler checks this
# before every run and refuses when any readable process still does.
exec env \
  -u AWS_ACCESS_KEY_ID \
  -u AWS_SECRET_ACCESS_KEY \
  -u AWS_SESSION_TOKEN \
  -u AWS_CONTAINER_CREDENTIALS_FULL_URI \
  -u AWS_CONTAINER_AUTHORIZATION_TOKEN \
  /lambda-entrypoint.sh "$@"
