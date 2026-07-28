import type { Label } from "./api";

export function filterLabels(labels: Label[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return labels.filter((label) =>
    label.name.toLocaleLowerCase().includes(normalized),
  );
}

export function hasExactLabel(labels: Label[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return labels.some((label) => label.name.toLocaleLowerCase() === normalized);
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
