import "./workspace-indicator.css";
import type { DesktopBridge } from "../../contracts/desktop-bridge";

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L120322

export interface WorkspaceIndicatorProps {
  isFullscreen: boolean;
  label: string | null;
  platform: DesktopBridge["platform"];
}

export function WorkspaceIndicator({ isFullscreen, label, platform }: WorkspaceIndicatorProps) {
  // macOS owns the titlebar space used by the native traffic-light controls;
  // the conversation header already renders the active agent name there.
  if (platform === "darwin" || isFullscreen || label == null || label.length === 0) return null;
  return <div aria-label={label} aria-level={1} className="sand-chat-header__title" role="heading">
    <span className="sand-chat-header__name" title={label}>{label}</span>
  </div>;
}
