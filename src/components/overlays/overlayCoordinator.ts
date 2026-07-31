export type FloatingOverlay =
  | { type: "addMedia" }
  | { type: "addLink" }
  | { type: "labels" }
  | { type: "itemContext"; itemId: string }
  | { type: "spaceContext"; spaceId: string };

export type SpaceEditorRequest =
  | { mode: "create"; targetItemId: string | null }
  | { mode: "edit"; spaceId: string };

export type BlockingOverlay =
  | { type: "commandMenu" }
  | { type: "spaceEditor"; request: SpaceEditorRequest };

export type OverlayTarget =
  | { layer: "floating"; overlay: FloatingOverlay }
  | { layer: "blocking"; overlay: BlockingOverlay };

export type OverlayCoordinatorState = {
  floating: FloatingOverlay | null;
  blocking: BlockingOverlay | null;
  closing: OverlayTarget | null;
  pending: OverlayTarget | null;
};

export const initialOverlayCoordinatorState: OverlayCoordinatorState = {
  floating: null,
  blocking: null,
  closing: null,
  pending: null,
};

export function sameFloatingOverlay(
  left: FloatingOverlay | null,
  right: FloatingOverlay | null,
) {
  if (left?.type !== right?.type) return false;
  if (!left || !right) return true;
  if (left.type === "itemContext" && right.type === "itemContext") {
    return left.itemId === right.itemId;
  }
  if (left.type === "spaceContext" && right.type === "spaceContext") {
    return left.spaceId === right.spaceId;
  }
  return true;
}

function sameBlockingOverlay(
  left: BlockingOverlay | null,
  right: BlockingOverlay | null,
) {
  return left?.type === right?.type;
}

export function sameOverlayTarget(
  left: OverlayTarget | null,
  right: OverlayTarget | null,
) {
  if (left?.layer !== right?.layer || !left || !right) return left === right;
  return left.layer === "floating" && right.layer === "floating"
    ? sameFloatingOverlay(left.overlay, right.overlay)
    : left.layer === "blocking" && right.layer === "blocking"
      ? sameBlockingOverlay(left.overlay, right.overlay)
      : false;
}

export function isOverlayTargetActive(
  state: OverlayCoordinatorState,
  target: OverlayTarget,
) {
  return target.layer === "floating"
    ? sameFloatingOverlay(state.floating, target.overlay)
    : sameBlockingOverlay(state.blocking, target.overlay);
}

export function requestOverlayOpen(
  state: OverlayCoordinatorState,
  target: OverlayTarget,
): OverlayCoordinatorState {
  if (isOverlayTargetActive(state, target)) return state;

  const active: OverlayTarget | null = state.floating
    ? { layer: "floating", overlay: state.floating }
    : state.blocking
      ? { layer: "blocking", overlay: state.blocking }
      : null;

  if (active) {
    return {
      floating: null,
      blocking: null,
      closing: active,
      pending: target,
    };
  }

  if (state.closing) return { ...state, pending: target };

  return target.layer === "floating"
    ? { ...state, floating: target.overlay, pending: null }
    : { ...state, blocking: target.overlay, pending: null };
}

export function requestOverlayClose(
  state: OverlayCoordinatorState,
  target: OverlayTarget,
): OverlayCoordinatorState {
  if (!isOverlayTargetActive(state, target)) return state;
  return {
    floating: target.layer === "floating" ? null : state.floating,
    blocking: target.layer === "blocking" ? null : state.blocking,
    closing: target,
    pending: state.pending,
  };
}

export function completeOverlayClose(
  state: OverlayCoordinatorState,
  target: OverlayTarget,
): OverlayCoordinatorState {
  if (!sameOverlayTarget(state.closing, target)) return state;
  const pending = state.pending;
  if (!pending) return { ...state, closing: null };
  return pending.layer === "floating"
    ? {
        floating: pending.overlay,
        blocking: null,
        closing: null,
        pending: null,
      }
    : {
        floating: null,
        blocking: pending.overlay,
        closing: null,
        pending: null,
      };
}

export function closeAllOverlays(
  _state: OverlayCoordinatorState,
): OverlayCoordinatorState {
  return initialOverlayCoordinatorState;
}
