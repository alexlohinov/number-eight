import { useEffect, useRef } from "react";

type ClipboardPasteOptions = {
  disabled: boolean;
  onPaste: () => Promise<void>;
};

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.closest("input, textarea, select") !== null
  );
}

export function useClipboardPaste({
  disabled,
  onPaste,
}: ClipboardPasteOptions) {
  const inFlightRef = useRef(false);

  useEffect(() => {
    const handlePasteShortcut = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyV" ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        disabled ||
        inFlightRef.current ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      inFlightRef.current = true;
      void onPaste().finally(() => {
        inFlightRef.current = false;
      });
    };

    window.addEventListener("keydown", handlePasteShortcut);
    return () => window.removeEventListener("keydown", handlePasteShortcut);
  }, [disabled, onPaste]);
}
