#!/usr/bin/env bash

format_peer_changes_context() {
  local registry_file="$1"
  local max_patch_lines="${2:-20}"
  local max_files="${3:-5}"

  if [ ! -f "$registry_file" ]; then
    return 0
  fi

  jq -r --argjson maxLines "$max_patch_lines" --argjson maxFiles "$max_files" '
    if (.updates // [] | length) == 0 then empty
    else
      [(.updates // []) | group_by(.filePath)[] | sort_by(.timestamp) | last] |
      .[:$maxFiles] |
      length as $count |
      (map(
        "Peer " + .peerId + " changed " + .filePath + ":\n```diff\n" +
        ((.patch | split("\n")) as $lines |
          if ($lines | length) > $maxLines then
            ($lines[:$maxLines] | join("\n")) + "\n... (" + ($lines | length | tostring) + " total lines, truncated)"
          else
            .patch
          end
        ) + "\n```"
      ) | join("\n\n")) as $summary |
      (($count | tostring) + " pending peer change(s):\n\n" + $summary)
    end
  ' "$registry_file" 2>/dev/null || return 0
}

drain_peer_changes_registry() {
  local registry_file="$1"
  printf '{"updates":[],"updatedAt":%s}\n' "$(date +%s000)" > "$registry_file"
}
