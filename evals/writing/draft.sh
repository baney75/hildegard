#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Draft one brief with one copy of the skills: draft.sh <variant> <brief id> <brief text>
# The variant is a folder under $EVAL_DIR holding a skills/ tree (e.g. old = main's, new = this branch's).
# Runs Claude Code with no user settings, no MCP and only Read, Write and python3, as an ordinary user would.
V=$1; ID=$2; B=$3; E=${EVAL_DIR:-$HOME/.cache/hildegard-writing-eval}
cd "$E/$V" || exit 1
printf '%s' "You are using the Hildegard skill. Read skills/hildegard/SKILL.md first and follow it, reading any reference it points to for this kind of work. Then do this request. Save the final post as $ID.md in the current folder, and print only the final post.

Request: $B" | env -u ANTHROPIC_API_KEY timeout 900 claude -p --model sonnet --setting-sources "" --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' --no-session-persistence --allowedTools "Read,Write,Bash(python3:*)" \
  > "$E/$V-$ID.out" 2> "$E/$V-$ID.err"
