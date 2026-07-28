export const EDITABLE_CONTEXT_SELECTOR =
  'input, textarea, [contenteditable]:not([contenteditable="false"])';

export function isEditableApplicationElement(
  element: Pick<Element, "closest">,
) {
  return element.closest(EDITABLE_CONTEXT_SELECTOR) !== null;
}
