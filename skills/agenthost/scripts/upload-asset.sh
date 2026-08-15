#!/usr/bin/env bash
set -euo pipefail

file_path=${1:?usage: upload-asset.sh <file>}
: "${AGENTHOST_USERNAME:?set AGENTHOST_USERNAME}"
: "${AGENTHOST_OWNER_TOKEN:?set AGENTHOST_OWNER_TOKEN}"

base=${AGENTHOST_URL:-https://agenthost.page}

# Keep the owner token out of process argv. Bash's printf is a builtin and curl
# receives the header through an anonymous pipe-backed config file.
curl_auth() {
  curl --config <(printf 'header = "Authorization: Bearer %s"\n' "$AGENTHOST_OWNER_TOKEN") "$@"
}

name=$(basename "$file_path")
bytes=$(stat -c %s "$file_path" 2>/dev/null || stat -f %z "$file_path")
content_type=$(file --brief --mime-type "$file_path" 2>/dev/null || printf 'application/octet-stream')
body=$(jq -cn --arg name "$name" --arg type "$content_type" --argjson bytes "$bytes" \
  '{name:$name,contentType:$type,bytes:$bytes}')

init=$(curl_auth --fail-with-body --silent --show-error -X POST \
  -H 'Content-Type: application/json' \
  --data-binary "$body" \
  "$base/asset?username=$(printf %s "$AGENTHOST_USERNAME" | jq -sRr @uri)")

upload_url=$(jq -er .uploadUrl <<<"$init")
headers=()
while IFS=$'\t' read -r key value; do
  headers+=(-H "$key: $value")
done < <(jq -r '.uploadHeaders | to_entries[] | [.key,.value] | @tsv' <<<"$init")

# --upload-file streams the file and supplies the exact Content-Length signed by
# the control plane. The URL points at r2.cloudflarestorage.com, not the Worker.
curl --fail-with-body --silent --show-error --upload-file "$file_path" "${headers[@]}" "$upload_url" >/dev/null

complete_url=$(jq -er .completeUrl <<<"$init")
curl_auth --fail-with-body --silent --show-error -X POST \
  "$complete_url" | jq -e '.ok == true' >/dev/null

jq -er .shareUrl <<<"$init"
