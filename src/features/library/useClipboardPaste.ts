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
  const optionsRef = useRef({ disabled, onPaste });
  const inFlightRef = useRef(false);
  optionsRef.current = { disabled, onPaste };

  useEffect(() => {
    const handlePasteShortcut = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyV" ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        optionsRef.current.disabled ||
        inFlightRef.current ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      inFlightRef.current = true;
      void optionsRef.current.onPaste().finally(() => {
        inFlightRef.current = false;
      });
    };

    window.addEventListener("keydown", handlePasteShortcut);
    return () => window.removeEventListener("keydown", handlePasteShortcut);
  }, []);
}
