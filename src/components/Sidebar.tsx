import { Button } from "@base-ui/react/button";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Heart,
  Library,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Star,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { AppLocation } from "../hooks/useNavigationHistory";
import { IconButton } from "./IconButton";
import { SidebarItem } from "./SidebarItem";

type SidebarProps = {
  activeLocation: AppLocation;
  canGoBack: boolean;
  canGoForward: boolean;
  width: number;
  onCollapse: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

type NavigationItem = {
  label: string;
  icon: LucideIcon;
  location?: AppLocation;
};

const libraryItems: NavigationItem[] = [
  { label: "All", icon: Library, location: "all" },
  { label: "Search", icon: Search },
  { label: "Favorites", icon: Star },
  { label: "Labels", icon: Tag },
  { label: "Archive", icon: Archive },
];

export function Sidebar({
  activeLocation,
  canGoBack,
  canGoForward,
  width,
  onCollapse,
  onGoBack,
  onGoForward,
  onResizeStart,
}: SidebarProps) {
  const [isSpacesExpanded, setIsSpacesExpanded] = useState(true);

  return (
    <aside
      aria-label="Library navigation"
      className="relative flex h-full shrink-0 flex-col overflow-hidden bg-background-2"
      style={{ width }}
    >
      <header
        className="flex h-11 shrink-0 items-center justify-end px-3 pb-1.5 pt-2.5"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-1.5">
          <IconButton
            disabled={!canGoBack}
            icon={ChevronLeft}
            label="Go back"
            onClick={onGoBack}
            variant="secondary"
          />
          <IconButton
            disabled={!canGoForward}
            icon={ChevronRight}
            label="Go forward"
            onClick={onGoForward}
            variant="secondary"
          />
          <IconButton icon={PanelLeft} label="Collapse sidebar" onClick={onCollapse} />
        </div>
      </header>

      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-3 py-2.5">
        <div className="flex flex-col gap-1">
          {libraryItems.map(({ label, icon: Icon, location }) => {
            const selected = location === activeLocation;

            return (
              <SidebarItem
                disabled
                icon={Icon}
                key={label}
                label={label}
                selected={selected}
              />
            );
          })}
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <Button
              aria-controls="spaces-items"
              aria-expanded={isSpacesExpanded}
              aria-label={isSpacesExpanded ? "Collapse Spaces" : "Expand Spaces"}
              className="focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-secondary hover:bg-component-hover hover:text-primary"
              onClick={() => setIsSpacesExpanded((expanded) => !expanded)}
              type="button"
            >
              <span>Spaces</span>
              {isSpacesExpanded ? (
                <ChevronDown aria-hidden="true" size={16} strokeWidth={1.4} />
              ) : (
                <ChevronRight aria-hidden="true" size={16} strokeWidth={1.4} />
              )}
            </Button>
            <IconButton disabled icon={Plus} label="Add space" />
          </div>
          <div hidden={!isSpacesExpanded} id="spaces-items">
            <SidebarItem disabled icon={Heart} label="Personal" />
          </div>
        </div>
      </nav>

      <footer className="shrink-0 px-3 pb-2.5 pt-1.5">
        <SidebarItem disabled icon={Settings} label="Settings" />
      </footer>

      <div
        aria-hidden="true"
        className="sidebar-resize-zone"
        onPointerDown={onResizeStart}
      />
    </aside>
  );
}
