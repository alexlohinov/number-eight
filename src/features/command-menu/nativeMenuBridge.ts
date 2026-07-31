import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  appCommandManifest,
  canExecuteAppCommand,
  getAppCommandTitle,
  isAppCommandId,
  isAppCommandChecked,
  spaceCommandId,
  type AppCommandId,
  type CommandContext,
  type ExecutableAppCommandId,
} from "./commandRegistry.ts";
import type { Space } from "../library/api";

export const NATIVE_COMMAND_EVENT = "no8://app-command";

export type NativeCommandEvent = {
  id: string;
};

export type NativeMenuCommandState = {
  id: AppCommandId;
  enabled: boolean;
  checked?: boolean;
  title: string;
};

export type NativeMenuStatePayload = {
  commands: NativeMenuCommandState[];
  spacesEnabled: boolean;
  spaces: Array<{
    id: string;
    name: string;
    active: boolean;
  }>;
};

export function deriveNativeMenuState(
  context: CommandContext,
  spaces: Space[],
): NativeMenuStatePayload {
  const commands = (Object.entries(appCommandManifest) as Array<
    [AppCommandId, (typeof appCommandManifest)[AppCommandId]]
  >)
    .filter(([, metadata]) => metadata.nativeMenu !== null)
    .map(([id, metadata]) => {
      const checked = isAppCommandChecked(id, context);
      return {
        id,
        enabled: canExecuteAppCommand(id, "native-menu", context),
        ...(checked === undefined ? {} : { checked }),
        title:
          id === "item.favorite.toggle" || id === "item.archive.toggle"
            ? getAppCommandTitle(id, context)
            : metadata.title,
      };
    });

  return {
    commands,
    spacesEnabled:
      !context.blockingEditorOpen &&
      !context.blockingOverlayOpen &&
      !context.editableFocused,
    spaces: spaces.map((space) => ({
      id: space.id,
      name: space.name,
      active:
        typeof context.currentLocation === "object" &&
        context.currentLocation.kind === "space" &&
        spaceCommandId(space.id) ===
          spaceCommandId(context.currentLocation.spaceId),
    })),
  };
}

type NativeCommandListen = (
  handler: (event: { payload: NativeCommandEvent }) => void,
) => Promise<UnlistenFn>;

export function registerNativeCommandListener(
  subscribe: NativeCommandListen,
  onCommand: (id: string) => void,
  onError: () => void,
) {
  let active = true;
  let unlisten: UnlistenFn | null = null;

  void subscribe((event) => onCommand(event.payload.id))
    .then((cleanup) => {
      if (active) unlisten = cleanup;
      else cleanup();
    })
    .catch(() => {
      if (active) onError();
    });

  return () => {
    active = false;
    unlisten?.();
    unlisten = null;
  };
}

export function listenForNativeCommands(
  onCommand: (id: string) => void,
  onError: () => void,
) {
  return registerNativeCommandListener(
    (handler) => listen<NativeCommandEvent>(NATIVE_COMMAND_EVENT, handler),
    onCommand,
    onError,
  );
}

type NativeMenuSender = (payload: NativeMenuStatePayload) => Promise<void>;

export function createNativeMenuStateSynchronizer(
  send: NativeMenuSender,
  onError: () => void,
) {
  let pending: NativeMenuStatePayload | null = null;
  let syncing = false;
  let disposed = false;

  const flush = async () => {
    if (syncing || disposed) return;
    syncing = true;
    try {
      while (!disposed && pending) {
        const payload = pending;
        pending = null;
        try {
          await send(payload);
        } catch {
          onError();
        }
      }
    } finally {
      syncing = false;
      if (!disposed && pending) void flush();
    }
  };

  return {
    enqueue(payload: NativeMenuStatePayload) {
      if (disposed) return;
      pending = payload;
      void flush();
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}

export function createTauriNativeMenuStateSynchronizer(onError: () => void) {
  return createNativeMenuStateSynchronizer(
    (payload) => invoke<void>("sync_native_menu_state", { payload }),
    onError,
  );
}

export function isExecutableCommandId(value: string): value is ExecutableAppCommandId {
  return isAppCommandId(value) || value.startsWith("navigate.space.");
}
