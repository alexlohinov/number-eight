import { Button } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Globe } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  normalizeLinkUrl,
  previewLinkMetadata,
} from "../features/library/api";
import { floatingSurfaceClassName } from "./overlays/floatingSurfaceStyles";
import { overlayLayerStyles } from "./overlays/overlayLayers";

type AddLinkPopoverProps = {
  anchorRef: RefObject<HTMLButtonElement | null>;
  onCreate: (url: string) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  open: boolean;
};

const VALIDATION_DELAY_MS = 700;
const PREVIEW_TIMEOUT_MS = 20_000;

type PreviewState = "idle" | "loading" | "ready" | "fallback";
type PreviewSource = { request: number; src: string } | null;

export function AddLinkPopover({
  anchorRef,
  onCreate,
  onOpenChange,
  onOpenChangeComplete,
  open,
}: AddLinkPopoverProps) {
  return (
    <AddLinkPopoverContent
      anchorRef={anchorRef}
      onCreate={onCreate}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      open={open}
    />
  );
}

function LinkPreview({
  onError,
  onLoad,
  source,
  state,
}: {
  onError: () => void;
  onLoad: () => void;
  source: PreviewSource;
  state: PreviewState;
}) {
  return (
    <div className="px-3 py-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-component-hover dark:bg-selected">
        {state === "loading" ? (
          <div
            aria-hidden="true"
            className="link-preview-skeleton absolute inset-0"
          />
        ) : null}
        {source ? (
          <img
            alt=""
            className={`absolute inset-0 size-full object-cover transition-opacity duration-150 ${
              state === "ready" ? "opacity-100" : "opacity-0"
            }`}
            draggable={false}
            onError={onError}
            onLoad={onLoad}
            src={source.src}
          />
        ) : null}
      </div>
    </div>
  );
}

function AddLinkPopoverContent({
  anchorRef,
  onCreate,
  onOpenChange,
  onOpenChangeComplete,
  open,
}: AddLinkPopoverProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isCreatingRef = useRef(false);
  const validationTimer = useRef<number | null>(null);
  const validationRequest = useRef(0);
  const previewRequest = useRef(0);
  const previewTimeout = useRef<number | null>(null);
  const [value, setValue] = useState("");
  const [normalizedUrl, setNormalizedUrl] = useState<string | null>(null);
  const [showError, setShowError] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [previewState, setPreviewState] = useState<PreviewState>("idle");
  const [previewSource, setPreviewSource] = useState<PreviewSource>(null);

  const clearValidationTimer = useCallback(() => {
    if (validationTimer.current !== null) {
      window.clearTimeout(validationTimer.current);
      validationTimer.current = null;
    }
  }, []);

  const clearPreviewTimeout = useCallback(() => {
    if (previewTimeout.current !== null) {
      window.clearTimeout(previewTimeout.current);
      previewTimeout.current = null;
    }
  }, []);

  const validate = useCallback(
    async (candidate: string) => {
      clearValidationTimer();
      const request = ++validationRequest.current;
      if (!candidate.trim()) {
        setNormalizedUrl(null);
        setShowError(false);
        return null;
      }

      try {
        const normalized = await normalizeLinkUrl(candidate);
        if (validationRequest.current !== request) return null;
        setNormalizedUrl(normalized);
        setShowError(false);
        return normalized;
      } catch {
        if (validationRequest.current !== request) return null;
        setNormalizedUrl(null);
        setShowError(true);
        return null;
      }
    },
    [clearValidationTimer],
  );

  useEffect(() => {
    if (!open || !value.trim()) return;
    validationTimer.current = window.setTimeout(() => {
      validationTimer.current = null;
      void validate(value);
    }, VALIDATION_DELAY_MS);
    return clearValidationTimer;
  }, [clearValidationTimer, open, validate, value]);

  useEffect(
    () => () => {
      clearValidationTimer();
      validationRequest.current += 1;
    },
    [clearValidationTimer],
  );

  useEffect(() => {
    const request = ++previewRequest.current;
    clearPreviewTimeout();
    setPreviewSource(null);
    if (!open || !normalizedUrl) {
      setPreviewState("idle");
      return;
    }

    let active = true;
    setPreviewState("loading");
    const timeout = window.setTimeout(() => {
      previewTimeout.current = null;
      active = false;
      if (previewRequest.current === request) {
        setPreviewState("fallback");
        setPreviewSource(null);
      }
    }, PREVIEW_TIMEOUT_MS);
    previewTimeout.current = timeout;

    previewLinkMetadata(normalizedUrl)
      .then((path) => {
        if (!active || previewRequest.current !== request) return;
        if (!path) {
          clearPreviewTimeout();
          setPreviewState("fallback");
          return;
        }
        setPreviewSource({ request, src: convertFileSrc(path) });
      })
      .catch(() => {
        if (!active || previewRequest.current !== request) return;
        clearPreviewTimeout();
        setPreviewState("fallback");
      });

    return () => {
      active = false;
      if (previewTimeout.current === timeout) {
        clearPreviewTimeout();
      }
    };
  }, [clearPreviewTimeout, normalizedUrl, open]);

  const create = async () => {
    if (isCreatingRef.current) return;
    const normalized = normalizedUrl ?? (await validate(value));
    if (!normalized || isCreatingRef.current) return;
    isCreatingRef.current = true;
    setIsCreating(true);
    try {
      const created = await onCreate(normalized);
      if (created) onOpenChange(false);
    } finally {
      isCreatingRef.current = false;
      setIsCreating(false);
    }
  };

  const handleOpenChangeComplete = (nextOpen: boolean) => {
    if (!nextOpen) {
      clearValidationTimer();
      clearPreviewTimeout();
      validationRequest.current += 1;
      previewRequest.current += 1;
      isCreatingRef.current = false;
      setValue("");
      setNormalizedUrl(null);
      setShowError(false);
      setIsCreating(false);
      setPreviewState("idle");
      setPreviewSource(null);
    }
    onOpenChangeComplete(nextOpen);
  };

  return (
    <Popover.Root
      modal={false}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={handleOpenChangeComplete}
      open={open}
    >
      <Popover.Portal>
        <Popover.Positioner
          align="end"
          anchor={anchorRef}
          side="bottom"
          sideOffset={8}
          style={overlayLayerStyles.floating}
        >
          <Popover.Popup
            className={`${floatingSurfaceClassName} w-[280px] outline-none`}
            finalFocus={anchorRef}
            initialFocus={inputRef}
          >
            <Popover.Title className="sr-only">Add link</Popover.Title>
            <label
              className={`add-link-input-row flex h-8 items-center gap-1.5 px-3 text-primary ${
                showError || normalizedUrl
                  ? "border-b-[0.5px] border-border-1"
                  : ""
              }`}
            >
              <Globe
                aria-hidden="true"
                className={value ? "text-primary" : "text-tertiary"}
                size={16}
                strokeWidth={1.4}
              />
              <input
                aria-describedby={showError ? "add-link-error" : undefined}
                aria-invalid={showError || undefined}
                aria-label="Web address"
                autoCapitalize="none"
                autoCorrect="off"
                className="h-4 min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] leading-4 text-primary outline-none placeholder:text-tertiary"
                onBlur={() => void validate(value)}
                onChange={(event) => {
                  validationRequest.current += 1;
                  setValue(event.currentTarget.value);
                  setNormalizedUrl(null);
                  setShowError(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void create();
                  }
                }}
                placeholder="Paste link"
                ref={inputRef}
                spellCheck={false}
                type="url"
                value={value}
              />
            </label>

            {showError ? (
              <div className="px-3 py-2 text-[13px] leading-4 text-error" id="add-link-error">
                Enter a full web address
              </div>
            ) : normalizedUrl ? (
              <>
                <LinkPreview
                  onError={() => {
                    if (previewRequest.current === previewSource?.request) {
                      clearPreviewTimeout();
                      setPreviewState("fallback");
                      setPreviewSource(null);
                    }
                  }}
                  onLoad={() => {
                    if (previewRequest.current === previewSource?.request) {
                      clearPreviewTimeout();
                      setPreviewState("ready");
                    }
                  }}
                  source={previewSource}
                  state={previewState}
                />
                <div className="flex items-center justify-end gap-1.5 border-t-[0.5px] border-border-1 px-3 py-2">
                  <Popover.Close
                    className="focus-ring flex h-7 items-center justify-center rounded-full px-3 text-xs font-medium leading-4 tracking-normal text-secondary hover:bg-component-hover hover:text-primary"
                    type="button"
                  >
                    Cancel
                  </Popover.Close>
                  <Button
                    className="focus-ring flex h-7 items-center justify-center rounded-full bg-accent px-3 text-xs font-medium leading-4 tracking-normal text-accent-foreground hover:[background:color-mix(in_srgb,var(--accent)_90%,var(--text-primary))] data-disabled:opacity-45"
                    disabled={!normalizedUrl || isCreating}
                    onClick={() => void create()}
                    type="button"
                  >
                    Create
                  </Button>
                </div>
              </>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
