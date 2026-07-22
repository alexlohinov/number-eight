import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";

type ImportImagePaths = (paths: string[]) => Promise<void>;

export function useFileDropImport(importImagePaths: ImportImagePaths) {
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    const subscription = getCurrentWebview().onDragDropEvent((event) => {
      if (!active) {
        return;
      }

      switch (event.payload.type) {
        case "drop":
          if (event.payload.paths.length > 0) {
            void importImagePaths(event.payload.paths);
          }
          break;
        case "enter":
        case "over":
        case "leave":
          break;
      }
    });

    void subscription
      .then((stopListening) => {
        if (active) {
          unlisten = stopListening;
        } else {
          stopListening();
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, [importImagePaths]);
}
