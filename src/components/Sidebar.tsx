import { Button } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
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
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { AppLocation } from "../hooks/useNavigationHistory";
import { isLabelLocation, isSpaceLocation } from "../hooks/useNavigationHistory";
import type { Label, Space } from "../features/library/api";
import { accentColor, SPACE_ICONS } from "../features/library/spaceIcons";
import { IconButton } from "./IconButton";
import { LabelMenu } from "./LabelMenu";
import { SidebarItem } from "./SidebarItem";
import { resolveSidebarItemVisualState } from "./sidebarItemModel";
import { SpaceContextMenu, type SpaceContextAction } from "./SpaceContextMenu";
import { floatingSurfaceClassName } from "./overlays/floatingSurfaceStyles";
import { overlayLayerStyles } from "./overlays/overlayLayers";

type SidebarProps = {
  activeLocation: AppLocation;
  canGoBack: boolean;
  canGoForward: boolean;
  labels: Label[];
  labelMenuOpen: boolean;
  labelsTriggerRef: RefObject<HTMLButtonElement | null>;
  width: number;
  onCollapse: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onNavigate: (location: AppLocation) => void;
  onLabelCreated: (label: Label) => void;
  onLabelMenuOpenChange: (open: boolean) => void;
  onLabelMenuOpenChangeComplete: (open: boolean) => void;
  onCreateSpace: () => void;
  onSpaceAction: (space: Space, action: SpaceContextAction) => void;
  onSpaceMenuOpenChange: (open: boolean, spaceId: string) => void;
  onSpaceMenuOpenChangeComplete: (open: boolean, spaceId: string) => void;
  onSearch: () => void;
  onSettings: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  spaces: Space[];
  spaceMenuOpenId: string | null;
};

type NavigationItem = {
  label: string;
  icon: LucideIcon;
  location?: AppLocation;
};

const libraryItems: NavigationItem[] = [
  { label: "All", icon: Library, location: "all" },
  { label: "Search", icon: Search },
  { label: "Favorites", icon: Star, location: "favorites" },
  { label: "Labels", icon: Tag },
  { label: "Archive", icon: Archive, location: "archive" },
];

export function Sidebar({
  activeLocation,
  canGoBack,
  canGoForward,
  labels,
  labelMenuOpen,
  labelsTriggerRef,
  width,
  onCollapse,
  onGoBack,
  onGoForward,
  onNavigate,
  onLabelCreated,
  onLabelMenuOpenChange,
  onLabelMenuOpenChangeComplete,
  onCreateSpace,
  onSpaceAction,
  onSpaceMenuOpenChange,
  onSpaceMenuOpenChangeComplete,
  onSearch,
  onSettings,
  onResizeStart,
  spaces,
  spaceMenuOpenId,
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
            const isSearch = label === "Search";
            const isLabels = label === "Labels";

            if (isLabels) {
              const activeLabelId = isLabelLocation(activeLocation)
                ? activeLocation.labelId
                : null;
              const isLabelRouteActive = activeLabelId !== null;
              const labelsVisualState = resolveSidebarItemVisualState(
                isLabelRouteActive,
                labelMenuOpen,
              );
              return (
                <Popover.Root
                  key={label}
                  onOpenChange={onLabelMenuOpenChange}
                  onOpenChangeComplete={onLabelMenuOpenChangeComplete}
                  open={labelMenuOpen}
                >
                  <Popover.Trigger
                    render={
                      <SidebarItem
                        icon={Icon}
                        label={label}
                        ref={labelsTriggerRef}
                        selected={isLabelRouteActive}
                        visualState={labelsVisualState}
                      />
                    }
                  />
                  <Popover.Portal>
                    <Popover.Positioner
                      align="start"
                      collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
                      collisionPadding={8}
                      side="right"
                      sideOffset={2}
                      style={overlayLayerStyles.floating}
                    >
                      <Popover.Popup
                        className={floatingSurfaceClassName}
                        finalFocus={labelsTriggerRef}
                        initialFocus={false}
                        render={
                          <LabelMenu
                            labels={labels}
                            mode={{ type: "browse", activeLabelId }}
                            onBrowseLabel={(selectedLabel) =>
                              onNavigate({ kind: "label", labelId: selectedLabel.id })
                            }
                            onLabelCreated={onLabelCreated}
                            onRequestClose={() => onLabelMenuOpenChange(false)}
                            open={labelMenuOpen}
                          />
                        }
                      />
                    </Popover.Positioner>
                  </Popover.Portal>
                </Popover.Root>
              );
            }

            return (
              <SidebarItem
                disabled={!location && !isSearch}
                icon={Icon}
                key={label}
                label={label}
                onClick={isSearch ? onSearch : location ? () => onNavigate(location) : undefined}
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
            <IconButton icon={Plus} label="Add space" onClick={onCreateSpace} />
          </div>
          <div className="flex flex-col gap-1" hidden={!isSpacesExpanded} id="spaces-items">
            {spaces.map((space) => {
              const Icon = SPACE_ICONS[space.iconKey];
              return (
                <SpaceContextMenu
                  key={space.id}
                  onAction={onSpaceAction}
                  onOpenChange={(open) => onSpaceMenuOpenChange(open, space.id)}
                  onOpenChangeComplete={onSpaceMenuOpenChangeComplete}
                  open={spaceMenuOpenId === space.id}
                  space={space}
                >
                  <SidebarItem
                    icon={Icon}
                    iconStyle={{ color: accentColor(space.colorKey) }}
                    label={space.name}
                    onClick={() => onNavigate({ kind: "space", spaceId: space.id })}
                    selected={isSpaceLocation(activeLocation) && activeLocation.spaceId === space.id}
                  />
                </SpaceContextMenu>
              );
            })}
          </div>
        </div>
      </nav>

      <footer className="shrink-0 px-3 pb-2.5 pt-1.5">
        <SidebarItem icon={Settings} label="Settings" onClick={onSettings} />
      </footer>

      <div
        aria-hidden="true"
        className="sidebar-resize-zone"
        onPointerDown={onResizeStart}
      />
    </aside>
  );
}
