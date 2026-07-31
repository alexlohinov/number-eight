import type { Label, SpaceColorKey } from "./api";

export type LabelMenuMode =
  | { type: "assign"; itemId: string }
  | { type: "browse"; activeLabelId: string | null };

export const MAX_LABEL_NAME_LENGTH = 80;

export const normalizedLabelName = (value: string) =>
  value.trim().toLocaleLowerCase();

export const trimmedLabelName = (value: string) => value.trim();

export const clampLabelName = (value: string) =>
  Array.from(value).slice(0, MAX_LABEL_NAME_LENGTH).join("");

export function labelCreateOperation(
  mode: LabelMenuMode,
  name: string,
  colorKey: SpaceColorKey,
) {
  return mode.type === "assign"
    ? { type: "create-and-assign" as const, itemId: mode.itemId, name, colorKey }
    : { type: "create" as const, name, colorKey };
}

export const labelMembershipTarget = (mode: LabelMenuMode) =>
  mode.type === "assign" ? mode.itemId : null;

export const escapeLabelMenuState = (state: "list" | "pick-color") =>
  state === "pick-color" ? "list" as const : "close" as const;

export function filterLabels(labels: Label[], query: string) {
  const normalized = normalizedLabelName(query);
  return labels
    .filter((label) => label.name.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => {
      const leftName = left.name.toLocaleLowerCase();
      const rightName = right.name.toLocaleLowerCase();
      const rankDifference =
        Number(!leftName.startsWith(normalized)) -
        Number(!rightName.startsWith(normalized));
      return (
        rankDifference ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
        left.id.localeCompare(right.id)
      );
    });
}

export function hasExactLabel(labels: Label[], query: string) {
  const normalized = normalizedLabelName(query);
  return labels.some((label) => label.name.toLocaleLowerCase() === normalized);
}

export function isValidNewLabelName(labels: Label[], query: string) {
  const name = trimmedLabelName(query);
  return (
    name.length > 0 &&
    Array.from(name).length <= MAX_LABEL_NAME_LENGTH &&
    !hasExactLabel(labels, name)
  );
}

export function moveLabelMenuActiveId(
  ids: string[],
  activeId: string | null,
  direction: 1 | -1,
) {
  if (ids.length === 0) return null;
  const currentIndex = activeId === null ? -1 : ids.indexOf(activeId);
  if (currentIndex < 0) return direction === 1 ? ids[0] : ids.at(-1) ?? null;
  return ids[(currentIndex + direction + ids.length) % ids.length];
}

export type LabelMenuVariant = "default" | "filled" | "pick-color" | "created";

export function labelMenuVariant(
  labels: Label[],
  query: string,
  pickingColor: boolean,
): LabelMenuVariant {
  if (pickingColor) return "pick-color";
  if (query.trim() && !hasExactLabel(labels, query)) return "filled";
  return labels.length > 0 ? "created" : "default";
}
