export const EDITABLE_CONTEXT_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export function isEditableApplicationElement(
  element: Pick<Element, "closest">,
) {
  return element.closest(EDITABLE_CONTEXT_SELECTOR) !== null;
}

export function shouldSuppressNativeContextMenu(
  element: Pick<Element, "closest">,
) {
  return !isEditableApplicationElement(element);
}
