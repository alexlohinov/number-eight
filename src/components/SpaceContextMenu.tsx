import { ContextMenu } from "@base-ui/react/context-menu";
import { useRef, type ReactNode } from "react";
import type { Space } from "../features/library/api";
import { floatingSurfaceClassName } from "./overlays/floatingSurfaceStyles";
import { overlayLayerStyles } from "./overlays/overlayLayers";

export type SpaceContextAction = "edit" | "delete";

type SpaceContextMenuProps = {
  children: ReactNode;
  onAction: (space: Space, action: SpaceContextAction) => void;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean, spaceId: string) => void;
  open: boolean;
  space: Space;
};

const rowClass =
  "flex h-8 w-full cursor-default items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium leading-4 text-primary outline-none data-[highlighted]:bg-component-hover";

export function SpaceContextMenu({
  children,
  onAction,
  onOpenChange,
  onOpenChangeComplete,
  open,
  space,
}: SpaceContextMenuProps) {
  const pendingAction = useRef<SpaceContextAction | null>(null);
  const targetRef = useRef(space);

  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) {
          pendingAction.current = null;
          targetRef.current = space;
        }
        onOpenChange(open);
      }}
      onOpenChangeComplete={(open) => {
        if (!open && pendingAction.current !== null) {
          const action = pendingAction.current;
          pendingAction.current = null;
          onAction(targetRef.current, action);
        }
        onOpenChangeComplete(open, targetRef.current.id);
      }}
      open={open}
    >
      <ContextMenu.Trigger className="w-full">{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner
          className="outline-none"
          style={overlayLayerStyles.floating}
        >
          <ContextMenu.Popup className={`${floatingSurfaceClassName} w-[190px] p-1 outline-none`}>
            <ContextMenu.Item
              className={rowClass}
              label="Edit Space"
              onClick={() => {
                pendingAction.current = "edit";
              }}
            >
              Edit Space
            </ContextMenu.Item>
            <ContextMenu.Item
              className={rowClass}
              label="Delete Space"
              onClick={() => {
                pendingAction.current = "delete";
              }}
            >
              Delete Space
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
