export function openItemContextSelection(
  selectedItemId: string | null,
  targetId: string,
) {
  return {
    menuOpenItemId: targetId,
    selectedItemId: targetId,
    temporarySelectionId: selectedItemId === targetId ? null : targetId,
  };
}

export function closeItemContextSelection(
  selectedItemId: string | null,
  temporarySelectionId: string | null,
  targetId: string,
  active: boolean,
) {
  const clearTemporarySelection = active && temporarySelectionId === targetId;
  return {
    selectedItemId: clearTemporarySelection ? null : selectedItemId,
    temporarySelectionId: clearTemporarySelection ? null : temporarySelectionId,
  };
}
