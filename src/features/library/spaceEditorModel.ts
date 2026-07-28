import type { Space } from "./api";

export function isDuplicateSpaceName(
  spaces: Space[],
  name: string,
  excludedSpaceId?: string,
) {
  const normalized = name.trim().toLocaleLowerCase();
  return spaces.some(
    (space) =>
      space.id !== excludedSpaceId &&
      space.name.toLocaleLowerCase() === normalized,
  );
}
