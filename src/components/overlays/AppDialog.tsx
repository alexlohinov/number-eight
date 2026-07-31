import { Dialog } from "@base-ui/react/dialog";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
} from "react";
import { overlayLayerStyles } from "./overlayLayers";

const classes = (base: string, extra?: string) =>
  extra ? `${base} ${extra}` : base;

function mergedClassName<State>(
  base: string,
  className: string | ((state: State) => string | undefined) | undefined,
) {
  return typeof className === "function"
    ? (state: State) => classes(base, className(state))
    : classes(base, className);
}

export const AppDialogBackdrop = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof Dialog.Backdrop>
>(function AppDialogBackdrop({ className, style, ...props }, ref) {
  return (
    <Dialog.Backdrop
      {...props}
      className={mergedClassName("app-dialog-backdrop", className)}
      ref={ref}
      style={{ ...overlayLayerStyles.modalBackdrop, ...style }}
    />
  );
});

export const AppDialogViewport = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof Dialog.Viewport>
>(function AppDialogViewport({ className, style, ...props }, ref) {
  return (
    <Dialog.Viewport
      {...props}
      className={mergedClassName("app-dialog-viewport", className)}
      ref={ref}
      style={{ ...overlayLayerStyles.modalPopup, ...style }}
    />
  );
});

export const AppDialogPopup = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof Dialog.Popup>
>(function AppDialogPopup({ className, style, ...props }, ref) {
  return (
    <Dialog.Popup
      {...props}
      className={mergedClassName("app-dialog-popup", className)}
      ref={ref}
      style={{ pointerEvents: "auto", ...style } as CSSProperties}
    />
  );
});
