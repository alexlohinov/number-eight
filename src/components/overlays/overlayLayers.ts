import type { CSSProperties } from "react";

export const overlayLayers = {
  floating: 100,
  floatingSubmenu: 110,
  modalBackdrop: 200,
  modalPopup: 210,
  modalNestedFloating: 220,
} as const;

export const overlayLayerStyles = {
  floating: { zIndex: overlayLayers.floating },
  floatingSubmenu: { zIndex: overlayLayers.floatingSubmenu },
  modalBackdrop: { zIndex: overlayLayers.modalBackdrop },
  modalPopup: { zIndex: overlayLayers.modalPopup },
  modalNestedFloating: { zIndex: overlayLayers.modalNestedFloating },
} satisfies Record<keyof typeof overlayLayers, CSSProperties>;
