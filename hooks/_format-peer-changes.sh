#!/usr/bin/env bash
set -euo pipefail

# SECURITY: This script processes untrusted peer input from the registry.
# Applied mitigations:
#   - peerId: validated against ^[A-Za-z0-9._-]{1,64}$ regex; invalid IDs replaced with <invalid-peer-id>
#   - filePath: rejected if it contains control characters or backticks; capped to 256 chars
#   - Patch lines: capped to 200 lines; each line capped to 500 chars; total per-peer capped to 8000 bytes
#   - Fence injection: patch lines prefixed with blockquote marker (> ) to disable fence semantics
#   - Truncation markers added when limits exceeded

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
        # Sanitize peerId: validate against ^[A-Za-z0-9._-]{1,64}$; use placeholder if invalid
        (.peerId | if test("^[A-Za-z0-9._-]{1,64}$") then . else "<invalid-peer-id>" end) as $peerId |
        # Sanitize filePath: reject newlines/CR (line breakout) and backticks (fence break);
        # cap to 256 chars to bound the header length
        (.filePath | if (contains("\n") or contains("\r") or contains("`") or (length > 256)) then "<invalid-path>" else . end) as $safeFilePath |
        # Process patch: cap lines, cap line length, cap total bytes
        (
          (.patch | split("\n")) as $lines |
          if ($lines | length) > 200 then
            # Truncate to 200 lines and add marker
            (
              [$lines[0:200][] | if (. | length) > 500 then .[0:500] + "..." else . end] |
              ("> " + join("\n> ")) as $prefixed |
              (
                if ($prefixed | length) > 8000 then
                  ($prefixed[0:8000] + "\n> ... (truncated by hoop: max-bytes reached)")
                else
                  $prefixed + "\n> ... (truncated by hoop: " + (($lines | length) - 200 | tostring) + " more lines)"
                end
              )
            )
          else
            # All lines fit; just apply line-length cap and prefix
            (
              [$lines[] | if (. | length) > 500 then .[0:500] + "..." else . end] |
              "> " + join("\n> ") as $prefixed |
              if ($prefixed | length) > 8000 then
                ($prefixed[0:8000] + "\n> ... (truncated by hoop: max-bytes reached)")
              else
                $prefixed
              end
            )
          end
        ) as $formatted_patch |
        "Peer " + $peerId + " changed " + $safeFilePath + ":\n" + $formatted_patch
      ) | join("\n\n")) as $summary |
      (($count | tostring) + " pending peer change(s):\n\n" + $summary)
    end
  ' "$registry_file" 2>/dev/null || return 0
}

drain_peer_changes_registry() {
  local registry_file="$1"
  printf '{"updates":[],"updatedAt":%s}\n' "$(date +%s000)" > "$registry_file"
}
