import { Globe, Image as ImageIcon } from "lucide-react";
import { useState } from "react";

export type LibraryCardItem = {
  id: string;
  title: string;
  imageSrc?: string;
  imageAlt: string;
  displayHeight: number;
  sourceType: "image" | "link";
  sourceIconSrc?: string;
  metadataStatus?: "pending" | "ready" | "failed";
};

type LibraryCardProps = {
  highlighted?: boolean;
  item: LibraryCardItem;
};

export function LibraryCard({ highlighted = false, item }: LibraryCardProps) {
  const isLink = item.sourceType === "link";
  const isPending = isLink && item.metadataStatus === "pending";
  const displayTitle = isPending ? "Loading website…" : item.title;
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

  return (
    <article
      aria-busy={isLink ? isPending : undefined}
      className={`flex w-full flex-col overflow-hidden rounded-xl border-[0.5px] border-border-1 bg-surface-1 hover:bg-component-hover ${
        highlighted ? "library-card-highlight" : ""
      }`}
      id={`library-card-${item.id}`}
      style={{ height: item.displayHeight }}
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        {isPending ? (
          <div aria-hidden="true" className="link-preview-skeleton size-full" />
        ) : isLink ? (
          <div className="relative size-full bg-component-hover dark:bg-selected">
            {item.imageSrc && previewState !== "failed" ? (
              <img
                alt={item.imageAlt}
                className={`absolute inset-0 size-full object-cover transition-opacity duration-150 ${
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
        ) : item.imageSrc ? (
          <img
            alt={item.imageAlt}
            className="size-full object-cover"
            draggable={false}
            src={item.imageSrc}
          />
        ) : null}
      </div>
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-t-[0.5px] border-border-1 px-3 py-3">
        {isLink && item.sourceIconSrc ? (
          <img
            alt=""
            aria-hidden="true"
            className="size-4 shrink-0 rounded-full object-cover"
            src={item.sourceIconSrc}
          />
        ) : isLink ? (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-component-hover text-secondary dark:bg-selected">
            <Globe aria-hidden="true" size={12} strokeWidth={1.4} />
          </span>
        ) : (
          <ImageIcon aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.4} />
        )}
        <span className="min-w-0 flex-1 truncate text-primary">{displayTitle}</span>
      </div>
    </article>
  );
}
