"use client";
import { Settings, X } from "lucide-react";
import { IconButton } from "../ui";
import { Modal } from "../ui/Overlay";
import { SettingsSharing } from "./settings/SettingsSharing";
import { SettingsStack } from "./settings/SettingsStack";
import { SettingsMcps } from "./settings/SettingsMcps";

// Desktop-shell Settings sheet (Phase 3). Matches the mockup exactly: a
// `max-w-lg` sheet with a fixed header and a single scrolling body stacking
// Sharing → Stack → Enabled MCPs (gap-6). Not tabbed. A peer only sees MCPs
// (no host tunnel/stack surface).

export function SettingsSheet({
  open,
  onClose,
  isPeer,
}: {
  open: boolean;
  onClose: () => void;
  isPeer: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} label="Settings" className="max-w-lg max-h-[82vh]">
      <div className="flex items-center gap-2 px-5 h-14 shrink-0 border-b border-divider">
        <Settings className="w-4 h-4 text-ink-mute" />
        <span className="font-sans text-[14px] font-semibold text-ink">Settings</span>
        <IconButton label="Close" size="sm" className="ml-auto" onClick={onClose}>
          <X className="w-4 h-4" />
        </IconButton>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-6">
        {!isPeer && <SettingsSharing />}
        {!isPeer && <SettingsStack />}
        <SettingsMcps />
      </div>
    </Modal>
  );
}
