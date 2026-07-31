import { useCallback, useState } from "react";

export type AppLocation =
  | "all"
  | "favorites"
  | "archive"
  | { kind: "space"; spaceId: string }
  | { kind: "label"; labelId: string };

export const isSpaceLocation = (
  location: AppLocation,
): location is Extract<AppLocation, { kind: "space" }> =>
  typeof location === "object" && location.kind === "space";

export const isLabelLocation = (
  location: AppLocation,
): location is Extract<AppLocation, { kind: "label" }> =>
  typeof location === "object" && location.kind === "label";

export const appLocationKey = (location: AppLocation) =>
  isSpaceLocation(location)
    ? `space:${location.spaceId}`
    : isLabelLocation(location)
      ? `label:${location.labelId}`
      : location;

export type NavigationHistoryState<Location> = {
  entries: Location[];
  index: number;
};

function locationsEqual<Location>(left: Location, right: Location) {
  if (Object.is(left, right)) return true;
  return (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null &&
    "kind" in left &&
    "kind" in right &&
    left.kind === right.kind &&
    (("spaceId" in left &&
      "spaceId" in right &&
      left.spaceId === right.spaceId) ||
      ("labelId" in left &&
        "labelId" in right &&
        left.labelId === right.labelId))
  );
}

export function navigateHistory<Location>(
  history: NavigationHistoryState<Location>,
  nextLocation: Location,
) {
  const currentLocation = history.entries[history.index];
  if (locationsEqual(nextLocation, currentLocation)) return history;
  const entries = history.entries.slice(0, history.index + 1);
  entries.push(nextLocation);
  return { entries, index: entries.length - 1 };
}

export function removeHistoryEntries<Location>(
  history: NavigationHistoryState<Location>,
  shouldRemove: (location: Location) => boolean,
  fallback: Location,
): NavigationHistoryState<Location> {
  const candidates = history.entries.flatMap((entry, entryIndex) => {
    const current = entryIndex === history.index;
    if (!shouldRemove(entry)) return [{ entry, current }];
    return current ? [{ entry: fallback, current: true }] : [];
  });
  const compacted: Array<{ entry: Location; current: boolean }> = [];
  for (const candidate of candidates) {
    const previous = compacted.at(-1);
    if (previous && locationsEqual(previous.entry, candidate.entry)) {
      compacted[compacted.length - 1] = {
        ...previous,
        current: previous.current || candidate.current,
      };
    } else {
      compacted.push(candidate);
    }
  }
  if (compacted.length === 0) compacted.push({ entry: fallback, current: true });
  const index = Math.max(0, compacted.findIndex((candidate) => candidate.current));
  return { entries: compacted.map((candidate) => candidate.entry), index };
}

export function goBackInHistory<Location>(
  history: NavigationHistoryState<Location>,
) {
  return history.index === 0 ? history : { ...history, index: history.index - 1 };
}

export function goForwardInHistory<Location>(
  history: NavigationHistoryState<Location>,
) {
  return history.index === history.entries.length - 1
    ? history
    : { ...history, index: history.index + 1 };
}

export function useNavigationHistory<Location>(initialLocation: Location) {
  const [history, setHistory] = useState<NavigationHistoryState<Location>>(
    () => ({
      entries: [initialLocation],
      index: 0,
    }),
  );

  const navigate = useCallback((nextLocation: Location) => {
    setHistory((currentHistory) => navigateHistory(currentHistory, nextLocation));
  }, []);

  const goBack = useCallback(() => {
    setHistory(goBackInHistory);
  }, []);

  const goForward = useCallback(() => {
    setHistory(goForwardInHistory);
  }, []);

  const removeEntries = useCallback(
    (shouldRemove: (location: Location) => boolean, fallback: Location) => {
      setHistory((current) => removeHistoryEntries(current, shouldRemove, fallback));
    },
    [],
  );

  const reset = useCallback((location: Location) => {
    setHistory({ entries: [location], index: 0 });
  }, []);

  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.entries.length - 1;

  return {
    currentLocation: history.entries[history.index],
    navigate,
    goBack,
    goForward,
    removeEntries,
    reset,
    canGoBack,
    canGoForward,
  };
}
