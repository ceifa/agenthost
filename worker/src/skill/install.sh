#!/bin/sh
# Installs or updates the {{skillName}} Agent Skill for {{apexHost}}:
#   curl -fsSL https://{{apexHost}}/skill/install.sh | sh
set -eu

url="https://{{apexHost}}/skill/SKILL.md"
name="{{skillName}}"

set --
for parent in "$HOME/.claude" "$HOME/.agents"; do
  if [ -d "$parent" ]; then set -- "$@" "$parent/skills"; fi
done
if [ "$#" -eq 0 ]; then set -- "$HOME/.agents/skills"; fi

for root in "$@"; do
  dir="$root/$name"
  mkdir -p "$dir"
  curl -fsSL "$url" -o "$dir/SKILL.md.tmp"
  mv "$dir/SKILL.md.tmp" "$dir/SKILL.md"
  echo "Installed $dir/SKILL.md"
  if [ "$name" != agenthost ] && [ -e "$root/agenthost" ]; then
    echo "Found an older install at $root/agenthost; remove it to avoid two copies of the skill."
  fi
done

echo "Next: start a new agent session and ask it to publish something with {{apexHost}}."
