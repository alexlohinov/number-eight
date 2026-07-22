import { useEffect } from "react";

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
        isEditableTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      void onPaste();
    };

    window.addEventListener("keydown", handlePasteShortcut);
    return () => window.removeEventListener("keydown", handlePasteShortcut);
  }, [disabled, onPaste]);
}
