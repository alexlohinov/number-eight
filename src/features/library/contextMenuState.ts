export function itemContextSelection(targetId: string | null) {
  return {
    menuOpenItemId: targetId,
    selectedItemId: targetId,
  };
}
