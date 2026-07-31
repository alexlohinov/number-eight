import { Button } from "@base-ui/react/button";
import type { LucideIcon } from "lucide-react";
import { forwardRef, type CSSProperties } from "react";
import {
  resolveSidebarItemVisualState,
  SIDEBAR_ITEM_STATE_CLASS_NAMES,
  type SidebarItemVisualState,
} from "./sidebarItemModel";

type SidebarItemProps = {
  label: string;
  icon: LucideIcon;
  iconStyle?: CSSProperties;
  selected?: boolean;
  visualState?: SidebarItemVisualState;
  disabled?: boolean;
  onClick?: () => void;
};

export const SidebarItem = forwardRef<HTMLButtonElement, SidebarItemProps>(
  function SidebarItem(
    {
      label,
      icon: Icon,
      iconStyle,
      selected = false,
      visualState,
      disabled = false,
      onClick,
    },
    ref,
  ) {
    const resolvedVisualState =
      visualState ?? resolveSidebarItemVisualState(selected);
    const stateClassName =
      SIDEBAR_ITEM_STATE_CLASS_NAMES[resolvedVisualState];

    return (
      <Button
        aria-current={selected ? "page" : undefined}
        className={`focus-ring flex w-full items-center gap-1.5 overflow-hidden rounded-lg px-2 py-1.5 text-left font-medium ${stateClassName}`}
        data-selected={selected || undefined}
        data-state={resolvedVisualState}
        disabled={disabled}
        onClick={onClick}
        ref={ref}
        type="button"
      >
        <Icon
          aria-hidden="true"
          className="shrink-0"
          size={16}
          strokeWidth={1.4}
          style={iconStyle}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </Button>
    );
  },
);
