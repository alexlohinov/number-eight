import { useCallback, useEffect, useState } from "react";

export type AppLocation = "all";

type NavigationHistoryState<Location> = {
  entries: Location[];
  index: number;
};

export function useNavigationHistory<Location>(initialLocation: Location) {
  const [history, setHistory] = useState<NavigationHistoryState<Location>>(
    () => ({
      entries: [initialLocation],
      index: 0,
    }),
  );

  const navigate = useCallback((nextLocation: Location) => {
    setHistory((currentHistory) => {
      const currentLocation = currentHistory.entries[currentHistory.index];

      if (Object.is(nextLocation, currentLocation)) {
        return currentHistory;
      }

      const entries = currentHistory.entries.slice(
        0,
        currentHistory.index + 1,
      );
      entries.push(nextLocation);

      return {
        entries,
        index: entries.length - 1,
      };
    });
  }, []);

  const goBack = useCallback(() => {
    setHistory((currentHistory) => {
      if (currentHistory.index === 0) {
        return currentHistory;
      }

      return {
        ...currentHistory,
        index: currentHistory.index - 1,
      };
    });
  }, []);

  const goForward = useCallback(() => {
    setHistory((currentHistory) => {
      if (currentHistory.index === currentHistory.entries.length - 1) {
        return currentHistory;
      }

      return {
        ...currentHistory,
        index: currentHistory.index + 1,
      };
    });
  }, []);

  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.entries.length - 1;

  useEffect(() => {
    const handleNavigationShortcut = (event: KeyboardEvent) => {
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      if (event.code === "BracketLeft") {
        event.preventDefault();
        if (canGoBack) {
          goBack();
        }
        return;
      }

      if (event.code === "BracketRight") {
        event.preventDefault();
        if (canGoForward) {
          goForward();
        }
      }
    };

    window.addEventListener("keydown", handleNavigationShortcut);
    return () => window.removeEventListener("keydown", handleNavigationShortcut);
  }, [canGoBack, canGoForward, goBack, goForward]);

  return {
    currentLocation: history.entries[history.index],
    navigate,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
  };
}
