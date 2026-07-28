import { Button } from "@base-ui/react/button";
import type { LucideIcon } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

type IconButtonProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "aria-label" | "children"
> & {
  icon: LucideIcon;
  label: string;
  selected?: boolean;
  variant?: "primary" | "secondary";
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      className,
      disabled = false,
      icon: Icon,
      label,
      selected,
      type = "button",
      variant = "secondary",
      ...buttonProps
    },
    ref,
  ) {
    const isSelected = selected === true;
    const appearanceClassName = disabled
      ? variant === "primary"
        ? "border-[0.5px] border-border-1 bg-surface-1 text-disabled shadow-[0_1px_1px_rgb(0_0_0_/_0.04)]"
        : "bg-transparent text-disabled"
      : isSelected
        ? variant === "primary"
          ? "border-[0.5px] border-border-1 bg-selected text-primary shadow-[0_1px_1px_rgb(0_0_0_/_0.04)]"
          : "bg-selected text-primary"
        : variant === "primary"
          ? "border-[0.5px] border-border-1 bg-surface-1 text-primary shadow-[0_1px_1px_rgb(0_0_0_/_0.04)] hover:bg-component-hover active:bg-selected"
          : "bg-transparent text-secondary hover:bg-component-hover hover:text-primary active:bg-selected active:text-primary";

    return (
      <Button
        {...buttonProps}
        aria-label={label}
        className={`focus-ring flex size-7 shrink-0 items-center justify-center rounded-full transition-colors ${appearanceClassName} ${className ?? ""}`}
        data-selected={isSelected || undefined}
        data-variant={variant}
        disabled={disabled}
        ref={ref}
        type={type}
      >
        <Icon aria-hidden="true" size={16} strokeWidth={1.4} />
      </Button>
    );
  },
);
