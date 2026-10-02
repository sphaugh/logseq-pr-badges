import type { CacheEntry, PrState } from "./cache";
import type { PrRef } from "./ref";

const ICON_PATHS: Record<PrState, string> = {
  open: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  merged:
    "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z",
  closed:
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z",
  draft:
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z",
};

const Icon = ({ state }: { state: PrState }) => (
  <svg
    class="pr-badge__icon"
    viewBox="0 0 16 16"
    width={16}
    height={16}
    aria-hidden="true"
    focusable="false"
  >
    <path d={ICON_PATHS[state]} />
  </svg>
);

export const Badge = ({
  entry,
  pr,
  stale,
}: {
  entry: CacheEntry;
  pr: PrRef;
  stale: boolean;
}) => (
  <a
    class="pr-badge"
    data-state={entry.state}
    data-stale={stale}
    href={pr.url}
    target="_blank"
    rel="noopener noreferrer"
    title={`${entry.state} · ${pr.key}`}
  >
    <Icon state={entry.state} />
    <span class="pr-badge__title">{entry.title}</span>
  </a>
);

export const Skeleton = ({ pr }: { pr: PrRef }) => (
  <span
    class="pr-badge pr-badge--skeleton"
    aria-busy="true"
    title={`loading ${pr.key}`}
  >
    <span class="pr-badge__title">{pr.key}</span>
  </span>
);

export const ErrorBadge = ({ message }: { message: string }) => (
  <span class="pr-badge pr-badge--error" title={message}>
    <span class="pr-badge__icon" aria-hidden="true">
      ⚠
    </span>
    <span class="pr-badge__title">{message}</span>
  </span>
);

export const FallbackLink = ({
  pr,
  message,
}: {
  pr: PrRef;
  message: string;
}) => (
  <a
    class="pr-badge pr-badge--error"
    href={pr.url}
    target="_blank"
    rel="noopener noreferrer"
    title={message}
  >
    <span class="pr-badge__icon" aria-hidden="true">
      ⚠
    </span>
    <span class="pr-badge__title">{pr.key}</span>
  </a>
);
