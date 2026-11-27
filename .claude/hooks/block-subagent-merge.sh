#!/bin/sh
# Blocks `gh pr merge` from subagents (hook input carries agent_id for subagent tool calls). The architect merges.
input=$(cat)
case "$input" in
  *'"agent_id"'*)
    case "$input" in
      *'gh pr merge'*|*'pulls/'*'/merge'*)
        echo "Builders never merge. Push your branch and report; the architect merges." >&2
        exit 2 ;;
    esac ;;
esac
exit 0
