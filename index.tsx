/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { definePluginSettings } from "@api/Settings";
import { openImageModal } from "@utils/discord";
import {
  closeModal,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalProps,
  ModalRoot,
  ModalSize,
  openModal,
} from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";

import { Message } from "@vencord/discord-types";
import { Forms, NavigationRouter, React, RestAPI } from "@webpack/common";

interface MediaItem {
  url: string;
  proxyUrl: string;
  filename: string;
  type: "image" | "video";
  source: "file" | "embed" | "link" | "forward";
  width?: number;
  height?: number;
  messageId: string;
  channelId: string;
  guildId?: string;
  author: string;
  authorId?: string;
  avatarUrl?: string;
  isoDate: string;
}

type SortOption = "newest" | "oldest" | "author-asc" | "author-desc";

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface DuplicateGroup {
  items: MediaItem[];
  similarity: number;
}

interface HashResult {
  item: MediaItem;
  hash: string | null;
}

interface SearchContext {
  guildId: string;
  channelId: string;
  totalResults: number;
}

const settings = definePluginSettings({
  gridColumns: {
    type: OptionType.SLIDER,
    description: "Number of columns in grid view",
    default: 6,
    markers: [3, 4, 5, 6, 7, 8],
    stickToMarkers: true,
  },
  maxResults: {
    type: OptionType.SLIDER,
    description: "Maximum number of search results to fetch",
    default: 500,
    markers: [100, 250, 500, 1000, 2000, 5000],
    stickToMarkers: true,
  },
  autoOpen: {
    type: OptionType.BOOLEAN,
    description:
      "Automatically open grid when searching with has:image or has:video",
    default: false,
  },
  duplicateThreshold: {
    type: OptionType.SLIDER,
    description: "Similarity threshold for duplicate detection (%)",
    default: 85,
    markers: [70, 75, 80, 85, 90, 95],
    stickToMarkers: false,
  },
  autoMediaFilter: {
    type: OptionType.BOOLEAN,
    description:
      "Automatically add has:image,video to searches without media filters",
    default: false,
  },
});

const HASH_SIZE = 16;
const ABORT_DELAY = 10000;

class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

async function computeImageHash(
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const controller = signal ? null : new AbortController();
  const abortSignal = signal || controller!.signal;

  const timeoutId = setTimeout(() => controller?.abort(), ABORT_DELAY);

  try {
    const response = await fetch(url, { mode: "cors", signal: abortSignal });
    if (!response.ok) return null;

    const blob = await response.blob();
    clearTimeout(timeoutId);

    const bitmap = await createImageBitmap(blob);

    const canvas = document.createElement("canvas");
    canvas.width = HASH_SIZE + 1;
    canvas.height = HASH_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(bitmap, 0, 0, HASH_SIZE + 1, HASH_SIZE);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, HASH_SIZE + 1, HASH_SIZE);
    const pixels = imageData.data;

    const grays: number[][] = [];
    for (let y = 0; y < HASH_SIZE; y++) {
      const row: number[] = [];
      for (let x = 0; x < HASH_SIZE + 1; x++) {
        const idx = (y * (HASH_SIZE + 1) + x) * 4;
        const gray =
          pixels[idx] * 0.299 +
          pixels[idx + 1] * 0.587 +
          pixels[idx + 2] * 0.114;
        row.push(gray);
      }
      grays.push(row);
    }

    let hash = "";
    for (let y = 0; y < HASH_SIZE; y++) {
      for (let x = 0; x < HASH_SIZE; x++) {
        hash += grays[y][x] < grays[y][x + 1] ? "1" : "0";
      }
    }

    return hash;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      console.warn("[BetterMediaSearch] Image hashing timed out:", url);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function compareHashes(hash1: string, hash2: string): number {
  if (!hash1 || !hash2) return 0;
  const len = Math.min(hash1.length, hash2.length);
  if (len === 0) return 0;

  let matches = 0;
  for (let i = 0; i < len; i++) {
    if (hash1[i] === hash2[i]) matches++;
  }
  return matches / len;
}

async function findDuplicateGroups(
  items: MediaItem[],
  threshold: number,
  onProgress: (current: number, total: number, phase: string) => void,
  signal?: AbortSignal,
): Promise<DuplicateGroup[]> {
  const imageItems = items.filter((item) => item.type === "image");
  if (imageItems.length === 0) return [];

  const controller = new AbortController();
  const externalSignal = signal
    ? SignalUtils.combine(signal, controller.signal)
    : controller.signal;

  onProgress(0, imageItems.length, "Hashing images...");

  const hashResults: HashResult[] = [];
  const batchSize = 5;

  for (let i = 0; i < imageItems.length; i++) {
    if (externalSignal.aborted) {
      controller.abort();
      return [];
    }

    const item = imageItems[i];
    const hash = await computeImageHash(item.proxyUrl, externalSignal);
    hashResults.push({ item, hash });
    onProgress(i + 1, imageItems.length, "Hashing images...");

    if (i % batchSize === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  onProgress(0, hashResults.length, "Finding duplicates...");

  const used = new Set<number>();
  const groups: DuplicateGroup[] = [];

  for (let i = 0; i < hashResults.length; i++) {
    if (used.has(i) || !hashResults[i].hash) continue;

    const group: MediaItem[] = [hashResults[i].item];
    let maxSimilarity = 1;

    for (let j = i + 1; j < hashResults.length; j++) {
      if (used.has(j) || !hashResults[j].hash) continue;

      const similarity = compareHashes(
        hashResults[i].hash!,
        hashResults[j].hash!,
      );

      if (similarity >= threshold) {
        group.push(hashResults[j].item);
        used.add(j);
        maxSimilarity = Math.min(maxSimilarity, similarity);
      }
    }

    if (group.length > 1) {
      used.add(i);
      groups.push({ items: group, similarity: maxSimilarity });
    }

    onProgress(i + 1, hashResults.length, "Finding duplicates...");
  }

  groups.sort((a, b) => b.items.length - a.items.length);
  return groups;
}

const SignalUtils = {
  combine(...signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();
    const handleAbort = () => controller.abort();
    signals.forEach((s) => s.addEventListener("abort", handleAbort));
    return controller.signal;
  },
};

function extractMediaFromMessages(
  messages: Message[][],
  guildId?: string,
): MediaItem[] {
  const items: MediaItem[] = [];
  console.log("[BetterMediaSearch] extractMediaFromMessages called", {
    messageGroups: messages.length,
    guildId,
  });

  for (const messageGroup of messages) {
    for (const message of messageGroup) {
      console.log("[BetterMediaSearch] Processing message", {
        id: message.id,
        channel: message.channel_id,
        attachments: message.attachments?.length,
        embeds: message.embeds?.length,
      });
      const authorObj = message.author;
      const author = authorObj?.username || authorObj?.globalName || "Unknown";
      const authorId = authorObj?.id;
      const avatarUrl =
        authorId && authorObj?.avatar
          ? `https://cdn.discordapp.com/avatars/${authorId}/${authorObj.avatar}.png?size=32`
          : undefined;

      const msgRef =
        (message as any).message_reference || (message as any).messageReference;
      const isForwarded =
        msgRef?.type === 1 ||
        !!(message as any).message_snapshots?.length ||
        !!(message as any).messageSnapshots?.length;

      const isoDate = new Date(message.timestamp).toISOString();

      if (message.attachments?.length) {
        for (const attachment of message.attachments) {
          const contentType = (attachment as any).content_type || "";
          let type: "image" | "video" | null = null;

          if (
            contentType.startsWith("image/") ||
            /\.(png|jpg|jpeg|gif|webp|avif|svg)$/i.test(attachment.filename)
          ) {
            type = "image";
          } else if (
            contentType.startsWith("video/") ||
            /\.(mp4|webm|mov|avi|mkv)$/i.test(attachment.filename)
          ) {
            type = "video";
          }

          if (type) {
            items.push({
              url: attachment.url,
              proxyUrl: (attachment as any).proxy_url || attachment.url,
              filename: attachment.filename,
              type,
              source: isForwarded ? "forward" : "file",
              width: (attachment as any).width,
              height: (attachment as any).height,
              messageId: message.id,
              channelId: message.channel_id,
              guildId,
              author,
              authorId,
              avatarUrl,
              isoDate,
            });
          }
        }
      }

      if (message.embeds?.length) {
        for (const embed of message.embeds) {
          const isLink = !!(embed as any).provider || !!(embed as any).url;

          if (embed.image?.url) {
            items.push({
              url: embed.image.url,
              proxyUrl: (embed.image as any).proxy_url || embed.image.url,
              filename: "embed_image",
              type: "image",
              source: isForwarded ? "forward" : isLink ? "link" : "embed",
              width: embed.image.width,
              height: embed.image.height,
              messageId: message.id,
              channelId: message.channel_id,
              guildId,
              author,
              authorId,
              avatarUrl,
              isoDate,
            });
          }

          if (embed.video?.url) {
            items.push({
              url: embed.video.url,
              proxyUrl: (embed.video as any).proxy_url || embed.video.url,
              filename: "embed_video",
              type: "video",
              source: isForwarded ? "forward" : isLink ? "link" : "embed",
              width: embed.video.width,
              height: embed.video.height,
              messageId: message.id,
              channelId: message.channel_id,
              guildId,
              author,
              authorId,
              avatarUrl,
              isoDate,
            });
          }

          if (embed.thumbnail?.url && !embed.image) {
            items.push({
              url: embed.thumbnail.url,
              proxyUrl:
                (embed.thumbnail as any).proxy_url || embed.thumbnail.url,
              filename: "embed_thumbnail",
              type: "image",
              source: isForwarded ? "forward" : isLink ? "link" : "embed",
              width: embed.thumbnail.width,
              height: embed.thumbnail.height,
              messageId: message.id,
              channelId: message.channel_id,
              guildId,
              author,
              authorId,
              avatarUrl,
              isoDate,
            });
          }
        }
      }
    }
  }

  console.log("[BetterMediaSearch] extractMediaFromMessages result", {
    itemsFound: items.length,
    guildId,
  });
  return items;
}

interface AuthorGroup {
  key: string;
  label: string;
  count: number;
  avatarUrl?: string;
}

interface DateGroup {
  key: string;
  label: string;
  count: number;
}

function getDateGroups(items: MediaItem[]): DateGroup[] {
  const groups = new Map<string, number>();

  for (const item of items) {
    const date = new Date(item.isoDate);
    if (isNaN(date.getTime())) continue;

    const year = date.getFullYear();
    const month = date.getMonth();
    const key = `${year}-${String(month).padStart(2, "0")}`;

    groups.set(key, (groups.get(key) || 0) + 1);
  }

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  return Array.from(groups.entries())
    .map(([key, count]) => {
      const [year, month] = key.split("-");
      return {
        key,
        label: `${monthNames[parseInt(month)]} ${year}`,
        count,
      };
    })
    .sort((a, b) => b.key.localeCompare(a.key));
}

function getAuthorGroups(items: MediaItem[]): AuthorGroup[] {
  const groups = new Map<string, { count: number; avatarUrl?: string }>();

  for (const item of items) {
    const author = item.author || "Unknown";
    const existing = groups.get(author) || { count: 0 };
    existing.count++;
    if (item.avatarUrl && !existing.avatarUrl) {
      existing.avatarUrl = item.avatarUrl;
    }
    groups.set(author, existing);
  }

  return Array.from(groups.entries())
    .map(([key, val]) => ({
      key,
      label: key,
      count: val.count,
      avatarUrl: val.avatarUrl,
    }))
    .sort((a, b) => b.count - a.count);
}

function sortItems(items: MediaItem[], sortBy: SortOption): MediaItem[] {
  const sorted = [...items];
  switch (sortBy) {
    case "newest":
      return sorted.sort(
        (a, b) => new Date(b.isoDate).getTime() - new Date(a.isoDate).getTime(),
      );
    case "oldest":
      return sorted.sort(
        (a, b) => new Date(a.isoDate).getTime() - new Date(b.isoDate).getTime(),
      );
    case "author-asc":
      return sorted.sort((a, b) => a.author.localeCompare(b.author));
    case "author-desc":
      return sorted.sort((a, b) => b.author.localeCompare(a.author));
    default:
      return sorted;
  }
}

function filterByDate(items: MediaItem[], dateKey: string | null): MediaItem[] {
  if (!dateKey) return items;

  return items.filter((item) => {
    const date = new Date(item.isoDate);
    if (isNaN(date.getTime())) return false;

    const year = date.getFullYear();
    const month = date.getMonth();
    const itemKey = `${year}-${String(month).padStart(2, "0")}`;

    return itemKey === dateKey;
  });
}

function DateSidebar({
  dateGroups,
  selectedDate,
  onSelectDate,
  totalCount,
}: {
  dateGroups: DateGroup[];
  selectedDate: string | null;
  onSelectDate: (key: string | null) => void;
  totalCount: number;
}) {
  if (dateGroups.length === 0) return null;

  return (
    <div className="vc-media-date-sidebar">
      <div className="vc-media-date-sidebar-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11zM9 11H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2zm-8 4H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z" />
        </svg>
        Dates
      </div>
      <div className="vc-media-date-list">
        <button
          className={`vc-media-date-item ${selectedDate === null ? "active" : ""}`}
          onClick={() => onSelectDate(null)}
        >
          <span className="vc-media-date-label">All Media</span>
          <span className="vc-media-date-count">{totalCount}</span>
        </button>
        {dateGroups.map((group) => (
          <button
            key={group.key}
            className={`vc-media-date-item ${selectedDate === group.key ? "active" : ""}`}
            onClick={() => onSelectDate(group.key)}
          >
            <span className="vc-media-date-label">{group.label}</span>
            <span className="vc-media-date-count">{group.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AuthorSidebar({
  authorGroups,
  selectedAuthor,
  onSelectAuthor,
  totalCount,
}: {
  authorGroups: AuthorGroup[];
  selectedAuthor: string | null;
  onSelectAuthor: (key: string | null) => void;
  totalCount: number;
}) {
  if (authorGroups.length === 0) return null;
  if (authorGroups.length === 1 && authorGroups[0].key === "Unknown")
    return null;

  return (
    <div className="vc-media-author-sidebar">
      <div className="vc-media-author-sidebar-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
        </svg>
        Authors
      </div>
      <div className="vc-media-author-list">
        <button
          className={`vc-media-author-item ${selectedAuthor === null ? "active" : ""}`}
          onClick={() => onSelectAuthor(null)}
        >
          <div className="vc-media-author-avatar-spacer"></div>
          <span className="vc-media-author-label">All</span>
          <span className="vc-media-author-count">{totalCount}</span>
        </button>
        {authorGroups.slice(0, 20).map((group) => (
          <button
            key={group.key}
            className={`vc-media-author-item ${selectedAuthor === group.key ? "active" : ""}`}
            onClick={() => onSelectAuthor(group.key)}
          >
            {group.avatarUrl ? (
              <img
                className="vc-media-author-avatar"
                src={group.avatarUrl}
                alt=""
              />
            ) : (
              <div className="vc-media-author-avatar-spacer"></div>
            )}
            <span className="vc-media-author-label" title={group.label}>
              {group.label}
            </span>
            <span className="vc-media-author-count">{group.count}</span>
          </button>
        ))}
        {authorGroups.length > 20 && (
          <div className="vc-media-author-more">
            +{authorGroups.length - 20} more
          </div>
        )}
      </div>
    </div>
  );
}

function VideoThumbnail({
  item,
  onClick,
}: {
  item: MediaItem;
  onClick: () => void;
}) {
  const [isHovering, setIsHovering] = React.useState(false);
  const [hasError, setHasError] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isHovering) {
      video.play().catch(() => setHasError(true));
    } else {
      video.pause();
      video.currentTime = 0;
    }
  }, [isHovering]);

  return (
    <>
      <div
        className="vc-media-video-container"
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        onClick={onClick}
        onKeyDown={(e) => e.key === "Enter" && onClick()}
        role="button"
        tabIndex={0}
        aria-label="Play video"
      >
        <video
          ref={videoRef}
          src={isHovering || hasError ? item.proxyUrl : undefined}
          poster=""
          muted
          loop
          playsInline
          preload="none"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={() => setHasError(true)}
        />
        {!isHovering && (
          <div className="vc-media-video-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
      </div>
      <span className="vc-media-card-badge">VIDEO</span>
    </>
  );
}

function MediaCard({
  item,
  onMediaClick,
  onJumpClick,
}: {
  item: MediaItem;
  onMediaClick: (item: MediaItem) => void;
  onJumpClick: (item: MediaItem) => void;
}) {
  return (
    <div className="vc-media-card">
      <div
        className="vc-media-card-image"
        onClick={() => onMediaClick(item)}
        onKeyDown={(e) => e.key === "Enter" && onMediaClick(item)}
        role="button"
        tabIndex={0}
      >
        {item.type === "video" ? (
          <VideoThumbnail item={item} onClick={() => onMediaClick(item)} />
        ) : (
          <img src={item.proxyUrl} alt={item.filename} loading="lazy" />
        )}
      </div>
      <div className="vc-media-card-footer">
        <div className="vc-media-card-info">
          <span className="vc-media-card-author">{item.author}</span>
          <span className="vc-media-card-date">{formatDate(item.isoDate)}</span>
        </div>
        <button
          className="vc-media-card-jump"
          onClick={() => onJumpClick(item)}
        >
          Jump
        </button>
      </div>
    </div>
  );
}

function DuplicateGroupsView({
  groups,
  onMediaClick,
  onJumpClick,
  onBack,
}: {
  groups: DuplicateGroup[];
  onMediaClick: (item: MediaItem) => void;
  onJumpClick: (item: MediaItem) => void;
  onBack: () => void;
}) {
  const columns = settings.store.gridColumns;

  if (groups.length === 0) {
    return (
      <div className="vc-media-duplicates-empty">
        <p>No duplicates found!</p>
        <button className="vc-media-filter-btn active" onClick={onBack}>
          Back to Gallery
        </button>
      </div>
    );
  }

  const totalDuplicates = groups.reduce((sum, g) => sum + g.items.length, 0);

  return (
    <div className="vc-media-duplicates-view">
      <div className="vc-media-duplicates-header">
        <button className="vc-media-filter-btn" onClick={onBack}>
          ← Back to Gallery
        </button>
        <span className="vc-media-duplicates-summary">
          Found {groups.length} groups with {totalDuplicates} similar images
        </span>
      </div>

      {groups.map((group, groupIdx) => (
        <div key={groupIdx} className="vc-media-duplicate-group">
          <div className="vc-media-duplicate-group-header">
            <span className="vc-media-duplicate-group-title">
              Group {groupIdx + 1}
            </span>
            <span className="vc-media-duplicate-group-info">
              {group.items.length} similar images (
              {Math.round(group.similarity * 100)}% match)
            </span>
          </div>
          <div
            className="vc-media-grid"
            style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
          >
            {group.items.map((item, idx) => (
              <MediaCard
                key={`${item.messageId}-${idx}`}
                item={item}
                onMediaClick={onMediaClick}
                onJumpClick={onJumpClick}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MediaGridModal({
  modalProps,
  mediaItems,
  onClose,
}: {
  modalProps: ModalProps;
  mediaItems: MediaItem[];
  onClose: () => void;
}) {
  const [typeFilter, setTypeFilter] = React.useState<
    "all" | "images" | "videos"
  >("all");
  const [sourceFilter, setSourceFilter] = React.useState<
    "all" | "file" | "embed" | "link" | "forward"
  >("all");
  const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
  const [selectedAuthor, setSelectedAuthor] = React.useState<string | null>(
    null,
  );
  const [view, setView] = React.useState<"gallery" | "duplicates">("gallery");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [sortBy, setSortBy] = React.useState<SortOption>("newest");

  const [duplicateGroups, setDuplicateGroups] = React.useState<
    DuplicateGroup[]
  >([]);
  const [isScanning, setIsScanning] = React.useState(false);
  const [scanProgress, setScanProgress] = React.useState({
    current: 0,
    total: 0,
    phase: "",
  });

  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [items, setItems] = React.useState<MediaItem[]>(mediaItems);

  const columns = settings.store.gridColumns;

  React.useEffect(() => {
    setItems(mediaItems);
  }, [mediaItems]);

  const dateGroups = React.useMemo(() => getDateGroups(items), [items]);
  const authorGroups = React.useMemo(() => getAuthorGroups(items), [items]);

  let filteredItems = filterByDate(items, selectedDate);

  if (selectedAuthor) {
    filteredItems = filteredItems.filter(
      (item) => item.author === selectedAuthor,
    );
  }

  filteredItems = filteredItems.filter((item) => {
    if (sourceFilter === "all") return true;
    return item.source === sourceFilter;
  });

  filteredItems = filteredItems.filter((item) => {
    if (typeFilter === "all") return true;
    if (typeFilter === "images") return item.type === "image";
    if (typeFilter === "videos") return item.type === "video";
    return true;
  });

  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase();
    filteredItems = filteredItems.filter(
      (item) =>
        item.author.toLowerCase().includes(query) ||
        item.filename.toLowerCase().includes(query),
    );
  }

  filteredItems = sortItems(filteredItems, sortBy);

  const imageCount = filteredItems.filter((m) => m.type === "image").length;
  const videoCount = filteredItems.filter((m) => m.type === "video").length;
  const fileCount = filteredItems.filter((m) => m.source === "file").length;
  const embedCount = filteredItems.filter((m) => m.source === "embed").length;
  const linkCount = filteredItems.filter((m) => m.source === "link").length;
  const forwardCount = filteredItems.filter(
    (m) => m.source === "forward",
  ).length;

  const handleMediaClick = (item: MediaItem) => {
    if (item.type === "image") {
      openImageModal({
        url: item.url,
        width: item.width,
        height: item.height,
      });
    } else {
      window.open(item.url, "_blank");
    }
  };

  const handleJumpClick = (item: MediaItem) => {
    onClose();
    const guildId = item.guildId || "@me";
    NavigationRouter.transitionTo(
      `/channels/${guildId}/${item.channelId}/${item.messageId}`,
    );
  };

  const handleFindDuplicates = async () => {
    if (isScanning) return;

    setIsScanning(true);
    setScanProgress({ current: 0, total: 0, phase: "Starting..." });

    try {
      const threshold = settings.store.duplicateThreshold / 100;
      const groups = await findDuplicateGroups(
        items,
        threshold,
        (current, total, phase) => setScanProgress({ current, total, phase }),
      );

      setDuplicateGroups(groups);
      setView("duplicates");
    } finally {
      setIsScanning(false);
    }
  };

  const hasActiveFilters =
    selectedDate !== null ||
    selectedAuthor !== null ||
    searchQuery.trim() !== "" ||
    typeFilter !== "all" ||
    sourceFilter !== "all";

  return (
    <ErrorBoundary>
      <ModalRoot
        {...modalProps}
        size={ModalSize.LARGE}
        className="vc-media-modal-root"
      >
        <ModalHeader className="vc-media-modal-header">
          <Forms.FormTitle tag="h2" style={{ margin: 0, flexGrow: 1 }}>
            Media Gallery{" "}
            <span className="vc-media-modal-count">
              {view === "gallery"
                ? `${filteredItems.length} items`
                : `${duplicateGroups.length} groups`}
            </span>
          </Forms.FormTitle>

          {view === "gallery" && (
            <>
              <div className="vc-media-modal-filters">
                <button
                  className={`vc-media-filter-btn ${typeFilter === "all" ? "active" : ""}`}
                  onClick={() => setTypeFilter("all")}
                >
                  All
                </button>
                <button
                  className={`vc-media-filter-btn ${typeFilter === "images" ? "active" : ""}`}
                  onClick={() => setTypeFilter("images")}
                >
                  Images ({imageCount})
                </button>
                <button
                  className={`vc-media-filter-btn ${typeFilter === "videos" ? "active" : ""}`}
                  onClick={() => setTypeFilter("videos")}
                >
                  Videos ({videoCount})
                </button>
              </div>

              <div className="vc-media-modal-filters vc-media-source-filters">
                <button
                  className={`vc-media-filter-btn small ${sourceFilter === "all" ? "active" : ""}`}
                  onClick={() => setSourceFilter("all")}
                >
                  All
                </button>
                {fileCount > 0 && (
                  <button
                    className={`vc-media-filter-btn small ${sourceFilter === "file" ? "active" : ""}`}
                    onClick={() => setSourceFilter("file")}
                  >
                    File
                  </button>
                )}
                {embedCount > 0 && (
                  <button
                    className={`vc-media-filter-btn small ${sourceFilter === "embed" ? "active" : ""}`}
                    onClick={() => setSourceFilter("embed")}
                  >
                    Embed
                  </button>
                )}
                {linkCount > 0 && (
                  <button
                    className={`vc-media-filter-btn small ${sourceFilter === "link" ? "active" : ""}`}
                    onClick={() => setSourceFilter("link")}
                  >
                    Link
                  </button>
                )}
                {forwardCount > 0 && (
                  <button
                    className={`vc-media-filter-btn small ${sourceFilter === "forward" ? "active" : ""}`}
                    onClick={() => setSourceFilter("forward")}
                  >
                    Fwd
                  </button>
                )}
              </div>

              <button
                className={`vc-media-filter-btn vc-media-find-duplicates-btn ${isScanning ? "scanning" : ""}`}
                onClick={handleFindDuplicates}
                disabled={isScanning || imageCount === 0}
              >
                {isScanning ? (
                  <>
                    <span className="vc-media-loading-spinner"></span>
                    {scanProgress.current}/{scanProgress.total}
                  </>
                ) : (
                  <>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
                    </svg>
                    Dupes
                  </>
                )}
              </button>
            </>
          )}

          <ModalCloseButton onClick={onClose} />
        </ModalHeader>

        <ModalContent className="vc-media-modal-content">
          <div
            className={`vc-media-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
          >
            {view === "gallery" && (
              <div
                className={`vc-media-sidebar-wrapper ${sidebarCollapsed ? "collapsed" : ""}`}
              >
                <button
                  className="vc-media-sidebar-toggle"
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    {sidebarCollapsed ? (
                      <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                    ) : (
                      <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                    )}
                  </svg>
                </button>
                {!sidebarCollapsed && (
                  <div className="vc-media-sidebar-content">
                    <div className="vc-media-search-wrapper">
                      <input
                        type="text"
                        className="vc-media-search-input"
                        placeholder="Search by author..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                      {searchQuery && (
                        <button
                          className="vc-media-search-clear"
                          onClick={() => setSearchQuery("")}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <DateSidebar
                      dateGroups={dateGroups}
                      selectedDate={selectedDate}
                      onSelectDate={setSelectedDate}
                      totalCount={items.length}
                    />
                    <AuthorSidebar
                      authorGroups={authorGroups}
                      selectedAuthor={selectedAuthor}
                      onSelectAuthor={setSelectedAuthor}
                      totalCount={items.length}
                    />
                    <div className="vc-media-sort-wrapper">
                      <select
                        className="vc-media-sort-select"
                        value={sortBy}
                        onChange={(e) =>
                          setSortBy(e.target.value as SortOption)
                        }
                      >
                        <option value="newest">Newest first</option>
                        <option value="oldest">Oldest first</option>
                        <option value="author-asc">Author A-Z</option>
                        <option value="author-desc">Author Z-A</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="vc-media-main-content">
              {view === "gallery" ? (
                <>
                  {hasActiveFilters && (
                    <div className="vc-media-active-filters">
                      <span className="vc-media-filter-label">Filters:</span>
                      {selectedDate && (
                        <span className="vc-media-filter-tag">
                          {
                            dateGroups.find(
                              (g: DateGroup) => g.key === selectedDate,
                            )?.label
                          }
                          <button onClick={() => setSelectedDate(null)}>
                            ×
                          </button>
                        </span>
                      )}
                      {selectedAuthor && (
                        <span className="vc-media-filter-tag">
                          {selectedAuthor}
                          <button onClick={() => setSelectedAuthor(null)}>
                            ×
                          </button>
                        </span>
                      )}
                      {searchQuery && (
                        <span className="vc-media-filter-tag">
                          "{searchQuery}"
                          <button onClick={() => setSearchQuery("")}>×</button>
                        </span>
                      )}
                      {(typeFilter !== "all" || sourceFilter !== "all") && (
                        <span className="vc-media-filter-tag">
                          {typeFilter !== "all" ? typeFilter : sourceFilter}
                          <button
                            onClick={() => {
                              setTypeFilter("all");
                              setSourceFilter("all");
                            }}
                          >
                            ×
                          </button>
                        </span>
                      )}
                      <button
                        className="vc-media-clear-filters"
                        onClick={() => {
                          setSelectedDate(null);
                          setSelectedAuthor(null);
                          setSearchQuery("");
                          setTypeFilter("all");
                          setSourceFilter("all");
                        }}
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                  <div
                    className="vc-media-grid"
                    style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
                  >
                    {filteredItems.length > 0 ? (
                      filteredItems.map((item, idx) => (
                        <MediaCard
                          key={`${item.messageId}-${idx}`}
                          item={item}
                          onMediaClick={handleMediaClick}
                          onJumpClick={handleJumpClick}
                        />
                      ))
                    ) : (
                      <div className="vc-media-empty">
                        {hasActiveFilters ? (
                          <>
                            <p>No media matches your filters</p>
                            <button
                              className="vc-media-filter-btn"
                              onClick={() => {
                                setSelectedDate(null);
                                setSelectedAuthor(null);
                                setSearchQuery("");
                                setTypeFilter("all");
                                setSourceFilter("all");
                              }}
                            >
                              Clear filters
                            </button>
                          </>
                        ) : (
                          <p>No media found in search results</p>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <DuplicateGroupsView
                  groups={duplicateGroups}
                  onMediaClick={handleMediaClick}
                  onJumpClick={handleJumpClick}
                  onBack={() => setView("gallery")}
                />
              )}
            </div>
          </div>
        </ModalContent>
      </ModalRoot>
    </ErrorBoundary>
  );
}

let currentModalKey: string | null = null;

function openMediaModal(items: MediaItem[]) {
  if (items.length === 0) {
    console.log("[BetterMediaSearch] openMediaModal called with no items");
    return;
  }
  console.log("[BetterMediaSearch] Opening media modal", {
    itemCount: items.length,
  });
  if (currentModalKey) {
    closeModal(currentModalKey);
  }

  currentModalKey = openModal((props: ModalProps) => (
    <MediaGridModal
      modalProps={props}
      mediaItems={items}
      onClose={() => {
        if (currentModalKey) closeModal(currentModalKey);
        currentModalKey = null;
      }}
    />
  ));
}

function closeMediaModal() {
  if (currentModalKey) {
    closeModal(currentModalKey);
    currentModalKey = null;
  }
}

const toggleButtonId = "vc-media-grid-toggle";
let lastButtonUpdate = 0;
const BUTTON_DEBOUNCE_MS = 100;

let lastAutoModifiedQuery = "";
let searchGeneration = 0;

function getSearchInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    '[class*="search"] [class*="input"], [class*="searchBar"] input, [class*="searchBox"] input',
  );
}

function injectMediaFilter() {
  if (!settings.store.autoMediaFilter) return;
  const input = getSearchInput();
  if (!input) return;
  const query = input.value;
  if (!query || query.includes("has:")) return;
  if (query === lastAutoModifiedQuery) return;

  lastAutoModifiedQuery = query;
  const newQuery = `${query} has:image,video`;

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  nativeInputValueSetter?.call(input, newQuery);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );

  console.log("[BetterMediaSearch] Auto-injected has:image,video into search", {
    original: query,
    modified: newQuery,
  });
}

function injectToggleButton(
  itemCount: number,
  totalResults: number,
  onClick: () => void,
) {
  const now = Date.now();
  if (now - lastButtonUpdate < BUTTON_DEBOUNCE_MS) return;
  lastButtonUpdate = now;

  const existingBtn = document.querySelector(`#${toggleButtonId}`);
  if (existingBtn) {
    const isLoading = (window as any).__betterMediaSearchLoading;
    if (isLoading) {
      const countText =
        totalResults > itemCount
          ? `${itemCount}/${totalResults}`
          : `${itemCount}`;
      existingBtn.className = `${toggleButtonId}-btn loading`;
      existingBtn.innerHTML = `
                <span class="vc-media-loading-spinner"></span>
                Loading... (${countText})
            `;
    } else {
      existingBtn.className = `${toggleButtonId}-btn`;
      existingBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M4 4h4v4H4V4zm6 0h4v4h-4V4zm6 0h4v4h-4V4zM4 10h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4zM4 16h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4z"/>
                </svg>
                Grid View (${itemCount})
            `;
    }
    return;
  }

  const selectors = [
    '[class*="searchHeader"]',
    '[class*="searchResultsHeader"]',
    '[class*="resultsHeader"]',
  ];

  let searchHeader: Element | null = null;
  for (const selector of selectors) {
    searchHeader = document.querySelector(selector);
    if (searchHeader) break;
  }

  if (!searchHeader) {
    const searchResults = document.querySelector('[class*="searchResult"]');
    if (searchResults) {
      searchHeader =
        searchResults
          .closest('[class*="container"]')
          ?.querySelector('[class*="header"]') || null;
    }
  }

  if (!searchHeader) {
    console.log(
      "[BetterMediaSearch] Could not find search header to inject button",
    );
    return;
  }

  const toggleBtn = document.createElement("button");
  toggleBtn.id = toggleButtonId;
  toggleBtn.className = `${toggleButtonId}-btn`;
  toggleBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24">
            <path fill="currentColor" d="M4 4h4v4H4V4zm6 0h4v4h-4V4zm6 0h4v4h-4V4zM4 10h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4zM4 16h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4z"/>
        </svg>
        Grid View (${itemCount})
    `;
  toggleBtn.title = "Open Media Grid";
  toggleBtn.onclick = onClick;

  searchHeader.appendChild(toggleBtn);
}

function removeToggleButton() {
  document.querySelector(`#${toggleButtonId}`)?.remove();
}

async function fetchAllSearchResults(
  guildId: string,
  initialMessages: any[],
  totalCount: number,
  searchData: any,
  onUpdate: (items: MediaItem[]) => void,
  setTotalResults: (n: number) => void,
  gen: number = -1,
): Promise<void> {
  (window as any).__betterMediaSearchLoading = true;

  try {
    const firstData = searchData.data?.[0];
    if (!firstData) {
      console.warn(
        "[BetterMediaSearch] No firstData in searchData, aborting fetch",
      );
      return;
    }

    let targetChannelId: string | null = null;
    if (initialMessages[0]?.[0]?.channel_id) {
      const channelIds = new Set<string>();
      for (const msgGroup of initialMessages) {
        for (const msg of msgGroup) {
          if (msg.channel_id) channelIds.add(msg.channel_id);
        }
      }
      if (channelIds.size === 1) {
        targetChannelId = initialMessages[0][0].channel_id;
      }
    }

    let hasImage = false;
    let hasVideo = false;
    for (const msgGroup of initialMessages) {
      for (const msg of msgGroup) {
        for (const att of msg.attachments || []) {
          const ct = att.content_type || "";
          if (
            ct.startsWith("image/") ||
            /\.(png|jpg|jpeg|gif|webp)$/i.test(att.filename || "")
          ) {
            hasImage = true;
          }
          if (
            ct.startsWith("video/") ||
            /\.(mp4|webm|mov)$/i.test(att.filename || "")
          ) {
            hasVideo = true;
          }
        }
      }
    }

    const limit = 25;
    let offset = limit;
    const maxResults = settings.store.maxResults;
    let currentItems: MediaItem[] = [];
    let retryCount = 0;

    while (offset < totalCount && offset < maxResults) {
      if (gen !== -1 && gen !== searchGeneration) {
        console.log("[BetterMediaSearch] Stale fetch stopped", {
          gen,
          current: searchGeneration,
        });
        break;
      }
      try {
        const searchUrl = `/guilds/${guildId}/messages/search`;
        const queryParams: Record<string, any> = {
          offset: offset,
          include_nsfw: true,
        };

        if (targetChannelId) {
          queryParams.channel_id = targetChannelId;
        }

        if (hasImage && hasVideo) {
          queryParams.has = "image";
        } else if (hasImage) {
          queryParams.has = "image";
        } else if (hasVideo) {
          queryParams.has = "video";
        }

        console.log("[BetterMediaSearch] Fetching page", {
          offset,
          totalCount,
          maxResults,
          retryCount,
        });
        const response = await RestAPI.get({
          url: searchUrl,
          query: queryParams,
        });
        console.log("[BetterMediaSearch] Page fetched", {
          offset,
          messages: response.body?.messages?.length,
        });

        if (response.body?.messages && response.body.messages.length > 0) {
          retryCount = 0;
          const newItems = extractMediaFromMessages(
            response.body.messages,
            guildId,
          );

          const existingIds = new Set(
            currentItems.map((item) => `${item.messageId}-${item.url}`),
          );
          const uniqueNewItems = newItems.filter(
            (item) => !existingIds.has(`${item.messageId}-${item.url}`),
          );

          if (uniqueNewItems.length > 0) {
            currentItems = [...currentItems, ...uniqueNewItems];
            onUpdate(currentItems);
            injectToggleButton(currentItems.length, totalCount, () =>
              openMediaModal(currentItems),
            );
          }

          if (response.body.messages.length < limit) {
            console.log("[BetterMediaSearch] Last page reached", {
              offset,
              received: response.body.messages.length,
            });
            break;
          }
        } else {
          console.log("[BetterMediaSearch] Empty page, stopping", { offset });
        }

        offset += limit;

        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        console.error("[BetterMediaSearch] Error fetching page:", error);
        retryCount++;
        if (retryCount >= 3) {
          console.warn("[BetterMediaSearch] Too many retries, stopping");
          break;
        }
        const backoffTime = Math.min(offset * 10, 5000);
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
      }
    }
    console.log("[BetterMediaSearch] Fetch loop complete", {
      totalItems: currentItems.length,
      offset,
    });
  } finally {
    (window as any).__betterMediaSearchLoading = false;
    injectToggleButton(currentItems.length, totalCount, () =>
      openMediaModal(currentItems),
    );
  }
}

function handleSearchResults(data: any) {
  console.log("[BetterMediaSearch] handleSearchResults called", data);

  if (settings.store.autoMediaFilter) {
    injectMediaFilter();
  }

  const gen = searchGeneration;

  let messages = data.messages || data.body?.messages || data.result?.messages;
  const guildId = data.guildId;
  const channelId = data.channelId;

  let searchData = null;
  let foundTotalResults = 0;

  if (!messages && data.data && Array.isArray(data.data) && data.data[0]) {
    const firstData = data.data[0];
    messages = firstData.messages;
    searchData = data;

    foundTotalResults =
      firstData.total_results ||
      firstData.totalResults ||
      data.total_results ||
      data.totalResults ||
      firstData.hit_count ||
      0;

    console.log("[BetterMediaSearch] Parsed data from SEARCH_FINISH", {
      totalResults: foundTotalResults,
      messageCount: messages?.length,
    });
  }

  if (!messages && data.searchResult?.messages) {
    messages = data.searchResult.messages;
    console.log("[BetterMediaSearch] Parsed data from searchResult");
  }

  if (!messages && Array.isArray(data) && data.length > 0) {
    messages = data;
    console.log("[BetterMediaSearch] Parsed data from raw array");
  }

  if (messages && messages.length > 0) {
    if (gen !== searchGeneration) {
      console.log("[BetterMediaSearch] Stale search results ignored", {
        gen,
        current: searchGeneration,
      });
      return;
    }
    console.log("[BetterMediaSearch] Processing search results", {
      totalMessages: messages.length,
      guildId,
      channelId,
    });
    const newItems = extractMediaFromMessages(messages, guildId);
    console.log("[BetterMediaSearch] Extracted media items", {
      count: newItems.length,
    });

    const countText =
      foundTotalResults > newItems.length
        ? `${newItems.length}/${foundTotalResults}`
        : `${newItems.length}`;

    injectToggleButton(newItems.length, foundTotalResults, () =>
      openMediaModal(newItems),
    );

    if (settings.store.autoOpen && newItems.length > 0) {
      console.log("[BetterMediaSearch] Auto-open enabled, opening modal");
      setTimeout(() => openMediaModal(newItems), 300);
    }

    if (foundTotalResults > newItems.length && guildId && searchData) {
      console.log("[BetterMediaSearch] More results available, fetching all", {
        total: foundTotalResults,
        current: newItems.length,
      });
      fetchAllSearchResults(
        guildId,
        messages,
        foundTotalResults,
        searchData,
        (items) =>
          injectToggleButton(items.length, foundTotalResults, () =>
            openMediaModal(items),
          ),
        () => {},
        gen,
      );
    } else {
      console.log("[BetterMediaSearch] No more results to fetch", {
        total: foundTotalResults,
        current: newItems.length,
        hasGuildId: !!guildId,
        hasSearchData: !!searchData,
      });
    }
  } else {
    console.log("[BetterMediaSearch] No messages found in search results");
  }
}

function cleanup() {
  searchGeneration++;
  lastAutoModifiedQuery = "";
  closeMediaModal();
  removeToggleButton();
}

export default definePlugin({
  name: "BetterMediaSearch",
  description:
    "Grid view for media in Discord search results with duplicate detection. Search with has:image or has:video, then click Grid View.",
  authors: [{ name: "aorer.", id: 0n }],
  settings,

  flux: {
    SEARCH_FINISH: handleSearchResults,
    SEARCH_MESSAGES_SUCCESS: handleSearchResults,
    SEARCH_CLEAR: cleanup,
    SEARCH_MESSAGES_CLEAR_ALL: cleanup,
    CHANNEL_SELECT() {
      closeMediaModal();
    },
  },

  start() {
    console.log("[BetterMediaSearch] Plugin started");
  },
  stop() {
    console.log("[BetterMediaSearch] Plugin stopping");
    cleanup();
  },
});
