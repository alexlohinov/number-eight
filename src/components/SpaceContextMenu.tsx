import { ContextMenu } from "@base-ui/react/context-menu";
import { useRef, type ReactNode } from "react";
import type { Space } from "../features/library/api";

export type SpaceContextAction = "edit" | "delete";

type SpaceContextMenuProps = {
  children: ReactNode;
  onAction: (space: Space, action: SpaceContextAction) => void;
  space: Space;
};

const rowClass =
  "flex h-8 w-full cursor-default items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium leading-4 text-primary outline-none data-[highlighted]:bg-component-hover";

export function SpaceContextMenu({ children, onAction, space }: SpaceContextMenuProps) {
  const pendingAction = useRef<SpaceContextAction | null>(null);
  const targetRef = useRef(space);

  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) {
          pendingAction.current = null;
          targetRef.current = space;
        }
      }}
      onOpenChangeComplete={(open) => {
        if (open || pendingAction.current === null) return;
        const action = pendingAction.current;
        pendingAction.current = null;
        onAction(targetRef.current, action);
      }}
    >
      <ContextMenu.Trigger className="w-full">{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup className="w-[190px] overflow-hidden rounded-xl border-[0.5px] border-border-1 bg-surface-1 p-1 outline-none [box-shadow:var(--shadow-menu)]">
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
