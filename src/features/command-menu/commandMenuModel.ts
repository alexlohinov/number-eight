import type { Space } from "../library/api";

export type SelectableResult = {
  id: string;
  disabled?: boolean;
};

export function normalizedSearchQuery(value: string) {
  return value.trim();
}

export function isCurrentRequest(currentSequence: number, requestSequence: number) {
  return currentSequence === requestSequence;
}

function searchableSpaceTerms(space: Space) {
  return [space.name, space.iconKey.replaceAll("-", " ")].map((term) =>
    term.toLocaleLowerCase(),
  );
}

export function filterSpaces(spaces: Space[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return spaces;
  return spaces
    .map((space, index) => {
      const terms = searchableSpaceTerms(space);
      const rank = terms.some((term) => term.startsWith(normalized))
        ? 0
        : terms.some((term) => term.includes(normalized))
          ? 1
          : null;
      return { space, index, rank };
    })
    .filter(
      (candidate): candidate is typeof candidate & { rank: number } =>
        candidate.rank !== null,
    )
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ space }) => space);
}

export function selectableResultIds(results: SelectableResult[]) {
  const ids: string[] = [];
  for (const result of results) {
    if (!result.disabled) ids.push(result.id);
  }
  return ids;
}

export function firstSelectableResultId(results: SelectableResult[]) {
  return selectableResultIds(results)[0] ?? null;
}

export function moveActiveResult(
  selectableIds: string[],
  activeId: string | null,
  direction: 1 | -1,
) {
  if (selectableIds.length === 0) return null;
  const currentIndex = activeId === null ? -1 : selectableIds.indexOf(activeId);
  if (currentIndex === -1) {
    return direction === 1 ? selectableIds[0] : selectableIds.at(-1)!;
  }
  return selectableIds[
    (currentIndex + direction + selectableIds.length) % selectableIds.length
  ];
}

export function optionDomId(resultId: string) {
  return `command-menu-option-${encodeURIComponent(resultId)}`;
}
