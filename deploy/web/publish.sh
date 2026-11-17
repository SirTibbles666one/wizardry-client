#!/bin/sh
# Builds the web app for wizardry.slothlee.xyz and copies it to the server.
#
#   ACCOUNT_SERVER=https://accounts.slothlee.xyz deploy/web/publish.sh root@your-server
#
# Run from the repository root. Files from the previous build that are no
# longer in this one are removed, except /assets/, which keeps old chunks so
# a tab still open on the last build can finish loading.
set -eu

target="${1:?usage: deploy/web/publish.sh user@host}"
dir="${WEB_ROOT:-/var/www/wizardry}"

: "${PUBLIC_WEB_ORIGIN:=https://wizardry.slothlee.xyz}"
export PUBLIC_WEB_ORIGIN
if [ -z "${ACCOUNT_SERVER:-}" ]; then
  echo "ACCOUNT_SERVER is unset: this build will have no email accounts." >&2
fi

npm run build
rsync -rlz --delete --exclude /assets/ dist/ "$target:$dir/"
rsync -rlz dist/assets/ "$target:$dir/assets/"
echo "Published to https://${PUBLIC_WEB_ORIGIN#https://}"
