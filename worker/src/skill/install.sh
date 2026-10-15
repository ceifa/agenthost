#!/bin/sh
# Installs or updates the {{skillName}} Agent Skill for {{apexHost}}:
#   curl -fsSL https://{{apexHost}}/skill/install.sh | sh
set -eu

base="https://{{apexHost}}/skill"
name="{{skillName}}"
files="{{skillFiles}}"

# Fetch every file before touching an install, so a failed download leaves the
# installed copy as it was instead of half updated.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT HUP TERM
for file in $files; do
  mkdir -p "$(dirname "$tmp/$file")"
  curl -fsSL "$base/$file" -o "$tmp/$file"
done

set --
for parent in "$HOME/.claude" "$HOME/.agents"; do
  if [ -d "$parent" ]; then set -- "$@" "$parent/skills"; fi
done
if [ "$#" -eq 0 ]; then set -- "$HOME/.agents/skills"; fi

for root in "$@"; do
  dir="$root/$name"
  for file in $files; do
    mkdir -p "$(dirname "$dir/$file")"
    cp "$tmp/$file" "$dir/$file.tmp"
    mv "$dir/$file.tmp" "$dir/$file"
    echo "Installed $dir/$file"
  done
  if [ "$name" != agenthost ] && [ -e "$root/agenthost" ]; then
    echo "Found an older install at $root/agenthost; remove it to avoid two copies of the skill."
  fi
done

echo "Next: start a new agent session and ask it to publish something with {{apexHost}}."
