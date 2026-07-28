import { Globe, Image as ImageIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FALLBACK_MEDIA_ASPECT_RATIO } from "./masonry";

export type LibraryCardItem = {
  id: string;
  title: string;
  imageSrc?: string;
  imageAlt: string;
  isFavorite: boolean;
  mediaAspectRatio?: number;
  sourceType: "image" | "link";
  sourceIconSrc?: string;
  metadataStatus?: "pending" | "ready" | "failed";
};

type LibraryCardProps = {
  highlighted?: boolean;
  item: LibraryCardItem;
  onCancelRename: () => void;
  onCommitRename: (title: string) => Promise<boolean>;
  onOpen: () => void;
  onSelect: () => void;
  renaming: boolean;
  selected: boolean;
};

export function LibraryCard({
  highlighted = false,
  item,
  onCancelRename,
  onCommitRename,
  onOpen,
  onSelect,
  renaming,
  selected,
}: LibraryCardProps) {
  const isLink = item.sourceType === "link";
  const isPending = isLink && item.metadataStatus === "pending";
  const displayTitle = isPending ? "Loading website…" : item.title;
  const inputRef = useRef<HTMLInputElement>(null);
  const committingRef = useRef(false);
  const [draftTitle, setDraftTitle] = useState(item.title);
  const [previewLoad, setPreviewLoad] = useState<{
    source: string | undefined;
    state: "idle" | "loaded" | "failed";
  }>({ source: item.imageSrc, state: item.imageSrc ? "idle" : "failed" });
  const previewState =
    previewLoad.source === item.imageSrc
      ? previewLoad.state
      : item.imageSrc
        ? "idle"
        : "failed";

  useEffect(() => {
    if (!renaming) return;
    setDraftTitle(item.title);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [item.title, renaming]);

  const commitRename = useCallback(async () => {
    if (committingRef.current) return;
    const title = draftTitle.trim();
    if (!title) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (title === item.title) {
      onCancelRename();
      return;
    }

    committingRef.current = true;
    const committed = await onCommitRename(title);
    committingRef.current = false;
    if (!committed) {
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [draftTitle, item.title, onCancelRename, onCommitRename]);

  return (
    <article
      aria-busy={isLink ? isPending : undefined}
      aria-label={item.title}
      aria-selected={selected}
      className={`focus-ring flex h-full w-full flex-col overflow-hidden rounded-xl border-[0.5px] border-border-1 outline-none hover:bg-component-hover ${
        selected ? "bg-selected" : "bg-surface-1"
      } ${highlighted ? "library-card-highlight" : ""}`}
      data-library-card={item.id}
      id={`library-card-${item.id}`}
      onDoubleClick={(event) => {
        if (!renaming && event.button === 0) onOpen();
      }}
      onFocus={(event) => {
        if (!renaming && event.currentTarget === event.target) onSelect();
      }}
      onPointerDown={(event) => {
        if (!renaming && (event.button === 0 || event.button === 2)) onSelect();
      }}
      role="option"
      tabIndex={renaming ? -1 : 0}
    >
      <div
        className="relative w-full shrink-0 overflow-hidden bg-component-hover"
        style={{ aspectRatio: item.mediaAspectRatio ?? FALLBACK_MEDIA_ASPECT_RATIO }}
      >
        {isPending ? (
          <div aria-hidden="true" className="link-preview-skeleton size-full" />
        ) : item.imageSrc && previewState !== "failed" ? (
          <img
            alt={item.imageAlt}
            className={`size-full object-contain transition-opacity duration-150 ${
              previewState === "loaded" ? "opacity-100" : "opacity-0"
            }`}
            draggable={false}
            onError={() => {
              setPreviewLoad({ source: item.imageSrc, state: "failed" });
            }}
            onLoad={() => {
              setPreviewLoad({ source: item.imageSrc, state: "loaded" });
            }}
            src={item.imageSrc}
          />
        ) : null}
      </div>
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-t-[0.5px] border-border-1 px-3 py-3">
        {isLink && item.sourceIconSrc ? (
          <img
            alt=""
            aria-hidden="true"
            className="size-4 shrink-0 rounded-full object-cover"
            draggable={false}
            src={item.sourceIconSrc}
          />
        ) : isLink ? (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-component-hover text-secondary">
            <Globe aria-hidden="true" size={12} strokeWidth={1.4} />
          </span>
        ) : (
          <ImageIcon aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.4} />
        )}
        {renaming ? (
          <input
            aria-label={`Rename ${item.title}`}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 leading-4 text-primary outline-none"
            onBlur={() => void commitRename()}
            onChange={(event) => setDraftTitle(event.target.value)}
            onContextMenu={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                void commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancelRename();
              }
            }}
            ref={inputRef}
            value={draftTitle}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-primary">{displayTitle}</span>
        )}
      </div>
    </article>
  );
}
