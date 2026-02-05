/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { openImageModal } from "@utils/discord";
import { closeModal, ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
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
    timestamp: string;
}

interface DuplicateGroup {
    items: MediaItem[];
    similarity: number;
}

interface HashResult {
    item: MediaItem;
    hash: string | null;
}

const settings = definePluginSettings({
    gridColumns: {
        type: OptionType.SLIDER,
        description: "Number of columns in grid view",
        default: 6,
        markers: [3, 4, 5, 6, 7, 8],
        stickToMarkers: true
    },
    maxResults: {
        type: OptionType.SLIDER,
        description: "Maximum number of search results to fetch (higher = slower)",
        default: 500,
        markers: [100, 250, 500, 1000, 2000, 5000],
        stickToMarkers: false
    },
    autoOpen: {
        type: OptionType.BOOLEAN,
        description: "Automatically open grid when searching with has:image or has:video",
        default: false
    },
    duplicateThreshold: {
        type: OptionType.SLIDER,
        description: "Similarity threshold for duplicate detection (%)",
        default: 85,
        markers: [70, 75, 80, 85, 90, 95],
        stickToMarkers: false
    }
});

let currentMediaItems: MediaItem[] = [];
let currentModalKey: string | null = null;
let isLoadingAll = false;
let currentGuildId: string = "";
let currentChannelId: string = "";
let totalResults: number = 0;

// ============ HASHING UTILITIES ============

const HASH_SIZE = 16;

async function computeImageHash(url: string): Promise<string | null> {
    try {
        const response = await fetch(url, { mode: "cors" });
        if (!response.ok) return null;

        const blob = await response.blob();
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

        // Convert to grayscale
        const grays: number[][] = [];
        for (let y = 0; y < HASH_SIZE; y++) {
            const row: number[] = [];
            for (let x = 0; x < HASH_SIZE + 1; x++) {
                const idx = (y * (HASH_SIZE + 1) + x) * 4;
                const gray = pixels[idx] * 0.299 + pixels[idx + 1] * 0.587 + pixels[idx + 2] * 0.114;
                row.push(gray);
            }
            grays.push(row);
        }

        // dHash: compare each pixel to its right neighbor
        let hash = "";
        for (let y = 0; y < HASH_SIZE; y++) {
            for (let x = 0; x < HASH_SIZE; x++) {
                hash += grays[y][x] < grays[y][x + 1] ? "1" : "0";
            }
        }

        return hash;
    } catch {
        return null;
    }
}

function compareHashes(hash1: string, hash2: string): number {
    if (!hash1 || !hash2) return 0;
    const minLen = Math.min(hash1.length, hash2.length);
    if (minLen === 0) return 0;

    let matches = 0;
    for (let i = 0; i < minLen; i++) {
        if (hash1[i] === hash2[i]) matches++;
    }
    return matches / minLen;
}

// ============ DUPLICATE DETECTION ============

async function findDuplicateGroups(
    items: MediaItem[],
    threshold: number,
    onProgress: (current: number, total: number, phase: string) => void
): Promise<DuplicateGroup[]> {
    // Only process images for now (video hashing is complex)
    const imageItems = items.filter(item => item.type === "image");

    if (imageItems.length === 0) return [];

    onProgress(0, imageItems.length, "Hashing images...");

    // Hash all images
    const hashResults: HashResult[] = [];
    for (let i = 0; i < imageItems.length; i++) {
        const item = imageItems[i];
        const hash = await computeImageHash(item.proxyUrl);
        hashResults.push({ item, hash });
        onProgress(i + 1, imageItems.length, "Hashing images...");

        // Small delay to prevent UI freeze
        if (i % 10 === 0) {
            await new Promise(r => setTimeout(r, 10));
        }
    }

    onProgress(0, hashResults.length, "Finding duplicates...");

    // Group similar images
    const used = new Set<number>();
    const groups: DuplicateGroup[] = [];

    for (let i = 0; i < hashResults.length; i++) {
        if (used.has(i) || !hashResults[i].hash) continue;

        const group: MediaItem[] = [hashResults[i].item];
        let maxSimilarity = 1;

        for (let j = i + 1; j < hashResults.length; j++) {
            if (used.has(j) || !hashResults[j].hash) continue;

            const similarity = compareHashes(hashResults[i].hash!, hashResults[j].hash!);
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

    // Sort groups by size (largest first)
    groups.sort((a, b) => b.items.length - a.items.length);

    return groups;
}

// ============ MEDIA EXTRACTION ============

function extractMediaFromMessages(messages: Message[][], guildId?: string): MediaItem[] {
    const items: MediaItem[] = [];

    for (const messageGroup of messages) {
        for (const message of messageGroup) {
            const authorObj = message.author as any;
            const author = authorObj?.username || authorObj?.global_name || authorObj?.globalName || "Unknown";
            const timestamp = new Date(message.timestamp as any).toLocaleDateString();

            // Check if this is a forwarded message
            const msgRef = (message as any).message_reference || (message as any).messageReference;
            const isForwarded = (msgRef?.type === 1) ||
                               !!(message as any).message_snapshots?.length ||
                               !!(message as any).messageSnapshots?.length;

            if (message.attachments?.length) {
                for (const attachment of message.attachments) {
                    const contentType = (attachment as any).content_type || "";
                    let type: "image" | "video" | null = null;

                    if (contentType.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp)$/i.test(attachment.filename)) {
                        type = "image";
                    } else if (contentType.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(attachment.filename)) {
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
                            timestamp
                        });
                    }
                }
            }

            if (message.embeds?.length) {
                for (const embed of message.embeds) {
                    // Check if this embed is from a link (has a URL provider)
                    const isLink = !!(embed as any).provider || !!(embed as any).url;

                    if (embed.image?.url) {
                        items.push({
                            url: embed.image.url,
                            proxyUrl: (embed.image as any).proxy_url || embed.image.url,
                            filename: "embed_image",
                            type: "image",
                            source: isForwarded ? "forward" : (isLink ? "link" : "embed"),
                            width: embed.image.width,
                            height: embed.image.height,
                            messageId: message.id,
                            channelId: message.channel_id,
                            guildId,
                            author,
                            timestamp
                        });
                    }
                    if (embed.video?.url) {
                        items.push({
                            url: embed.video.url,
                            proxyUrl: (embed.video as any).proxy_url || embed.video.url,
                            filename: "embed_video",
                            type: "video",
                            source: isForwarded ? "forward" : (isLink ? "link" : "embed"),
                            width: embed.video.width,
                            height: embed.video.height,
                            messageId: message.id,
                            channelId: message.channel_id,
                            guildId,
                            author,
                            timestamp
                        });
                    }
                    if (embed.thumbnail?.url && !embed.image) {
                        items.push({
                            url: embed.thumbnail.url,
                            proxyUrl: (embed.thumbnail as any).proxy_url || embed.thumbnail.url,
                            filename: "embed_thumbnail",
                            type: "image",
                            source: isForwarded ? "forward" : (isLink ? "link" : "embed"),
                            width: embed.thumbnail.width,
                            height: embed.thumbnail.height,
                            messageId: message.id,
                            channelId: message.channel_id,
                            guildId,
                            author,
                            timestamp
                        });
                    }
                }
            }
        }
    }

    return items;
}

// ============ DATE GROUPING ============

interface DateGroup {
    key: string;       // "2025-01" format for sorting
    label: string;     // "January 2025" for display
    count: number;
}

function getDateGroups(items: MediaItem[]): DateGroup[] {
    const groups = new Map<string, number>();

    for (const item of items) {
        // Parse the timestamp - it's formatted as toLocaleDateString() like "1/15/2025"
        let date: Date;
        try {
            // Try parsing the formatted date string (M/D/YYYY format)
            const parts = item.timestamp.split("/");
            if (parts.length === 3) {
                date = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
            } else {
                // Fallback to direct Date parsing
                date = new Date(item.timestamp);
            }
        } catch {
            continue;
        }

        if (isNaN(date.getTime())) continue;

        const year = date.getFullYear();
        const month = date.getMonth();
        const key = `${year}-${String(month).padStart(2, "0")}`;

        groups.set(key, (groups.get(key) || 0) + 1);
    }

    // Convert to array and sort by date (newest first)
    const monthNames = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];

    return Array.from(groups.entries())
        .map(([key, count]) => {
            const [year, month] = key.split("-");
            return {
                key,
                label: `${monthNames[parseInt(month)]} ${year}`,
                count
            };
        })
        .sort((a, b) => b.key.localeCompare(a.key)); // Newest first
}

function filterByDate(items: MediaItem[], dateKey: string | null): MediaItem[] {
    if (!dateKey) return items;

    return items.filter(item => {
        let date: Date;
        try {
            const parts = item.timestamp.split("/");
            if (parts.length === 3) {
                date = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
            } else {
                date = new Date(item.timestamp);
            }
        } catch {
            return false;
        }

        if (isNaN(date.getTime())) return false;

        const year = date.getFullYear();
        const month = date.getMonth();
        const itemKey = `${year}-${String(month).padStart(2, "0")}`;

        return itemKey === dateKey;
    });
}

// ============ COMPONENTS ============

// Date sidebar component
function DateSidebar({ dateGroups, selectedDate, onSelectDate, totalCount }: {
    dateGroups: DateGroup[];
    selectedDate: string | null;
    onSelectDate: (key: string | null) => void;
    totalCount: number;
}) {
    return (
        <div className="vc-media-date-sidebar">
            <div className="vc-media-date-sidebar-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11zM9 11H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2zm-8 4H7v2h2v-2zm4 0h-2v2h2v-2zm4 0h-2v2h2v-2z"/>
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
                {dateGroups.map(group => (
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

// Video thumbnail component - shows placeholder, loads video only on hover
function VideoThumbnail({ item, onClick }: { item: MediaItem; onClick: () => void; }) {
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
                            <path d="M8 5v14l11-7z"/>
                        </svg>
                    </div>
                )}
            </div>
            <span className="vc-media-card-badge">VIDEO</span>
        </>
    );
}

// Media card component
function MediaCard({ item, onMediaClick, onJumpClick }: {
    item: MediaItem;
    onMediaClick: (item: MediaItem) => void;
    onJumpClick: (item: MediaItem) => void;
}) {
    return (
        <div className="vc-media-card">
            <div
                className="vc-media-card-image"
                onClick={() => onMediaClick(item)}
            >
                {item.type === "video" ? (
                    <VideoThumbnail item={item} onClick={() => onMediaClick(item)} />
                ) : (
                    <img
                        src={item.proxyUrl}
                        alt={item.filename}
                        loading="lazy"
                    />
                )}
            </div>
            <div className="vc-media-card-footer">
                <div className="vc-media-card-info">
                    <span className="vc-media-card-author">{item.author}</span>
                    <span className="vc-media-card-date">{item.timestamp}</span>
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

// Duplicate groups view
function DuplicateGroupsView({ groups, onMediaClick, onJumpClick, onBack }: {
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
                            {group.items.length} similar images ({Math.round(group.similarity * 100)}% match)
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

// Main modal component
function MediaGridModal({ modalProps, mediaItems, onClose }: {
    modalProps: ModalProps;
    mediaItems: MediaItem[];
    onClose: () => void;
}) {
    const [typeFilter, setTypeFilter] = React.useState<"all" | "images" | "videos">("all");
    const [sourceFilter, setSourceFilter] = React.useState<"all" | "file" | "embed" | "link" | "forward">("all");
    const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
    const [view, setView] = React.useState<"gallery" | "duplicates">("gallery");
    const [duplicateGroups, setDuplicateGroups] = React.useState<DuplicateGroup[]>([]);
    const [isScanning, setIsScanning] = React.useState(false);
    const [scanProgress, setScanProgress] = React.useState({ current: 0, total: 0, phase: "" });
    const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);
    const columns = settings.store.gridColumns;

    // Set up interval to update when loading
    React.useEffect(() => {
        const interval = setInterval(() => {
            if (isLoadingAll || currentMediaItems.length !== mediaItems.length) {
                forceUpdate();
            }
        }, 500);
        return () => clearInterval(interval);
    }, [mediaItems.length]);

    // Use current media items to get real-time updates
    const items = currentMediaItems;

    // Get date groups for sidebar
    const dateGroups = React.useMemo(() => getDateGroups(items), [items]);

    // Apply all filters: date -> source -> type
    const dateFilteredItems = filterByDate(items, selectedDate);
    const sourceFilteredItems = dateFilteredItems.filter(item => {
        if (sourceFilter === "all") return true;
        return item.source === sourceFilter;
    });
    const filteredItems = sourceFilteredItems.filter(item => {
        if (typeFilter === "all") return true;
        if (typeFilter === "images") return item.type === "image";
        if (typeFilter === "videos") return item.type === "video";
        return true;
    });

    // Counts for filter buttons (based on date + source filter)
    const imageCount = sourceFilteredItems.filter(m => m.type === "image").length;
    const videoCount = sourceFilteredItems.filter(m => m.type === "video").length;

    // Source counts (based on date filter only)
    const fileCount = dateFilteredItems.filter(m => m.source === "file").length;
    const embedCount = dateFilteredItems.filter(m => m.source === "embed").length;
    const linkCount = dateFilteredItems.filter(m => m.source === "link").length;
    const forwardCount = dateFilteredItems.filter(m => m.source === "forward").length;

    const handleMediaClick = (item: MediaItem) => {
        if (item.type === "image") {
            openImageModal({
                url: item.url,
                width: item.width,
                height: item.height
            });
        } else {
            window.open(item.url, "_blank");
        }
    };

    const handleJumpClick = (item: MediaItem) => {
        onClose();
        const guildId = item.guildId || "@me";
        NavigationRouter.transitionTo(`/channels/${guildId}/${item.channelId}/${item.messageId}`);
    };

    const handleFindDuplicates = async () => {
        if (isScanning || isLoadingAll) return;

        setIsScanning(true);
        setScanProgress({ current: 0, total: 0, phase: "Starting..." });

        try {
            const threshold = settings.store.duplicateThreshold / 100;
            const groups = await findDuplicateGroups(
                items,
                threshold,
                (current, total, phase) => setScanProgress({ current, total, phase })
            );

            setDuplicateGroups(groups);
            setView("duplicates");
        } finally {
            setIsScanning(false);
        }
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE} className="vc-media-modal-root">
            <ModalHeader className="vc-media-modal-header">
                <Forms.FormTitle tag="h2" style={{ margin: 0, flexGrow: 1 }}>
                    {view === "gallery" ? "Media Gallery" : "Duplicate Images"}
                    <span className="vc-media-modal-count">
                        {view === "gallery" ? `${filteredItems.length} items` : `${duplicateGroups.length} groups`}
                    </span>
                </Forms.FormTitle>

                {view === "gallery" && (
                    <>
                        {/* Type filters */}
                        <div className="vc-media-modal-filters">
                            <button
                                className={`vc-media-filter-btn ${typeFilter === "all" ? "active" : ""}`}
                                onClick={() => setTypeFilter("all")}
                            >
                                All ({sourceFilteredItems.length})
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

                        {/* Source filters */}
                        <div className="vc-media-modal-filters vc-media-source-filters">
                            <button
                                className={`vc-media-filter-btn small ${sourceFilter === "all" ? "active" : ""}`}
                                onClick={() => setSourceFilter("all")}
                                title="All sources"
                            >
                                All
                            </button>
                            {fileCount > 0 && (
                                <button
                                    className={`vc-media-filter-btn small ${sourceFilter === "file" ? "active" : ""}`}
                                    onClick={() => setSourceFilter("file")}
                                    title="Uploaded files"
                                >
                                    File ({fileCount})
                                </button>
                            )}
                            {embedCount > 0 && (
                                <button
                                    className={`vc-media-filter-btn small ${sourceFilter === "embed" ? "active" : ""}`}
                                    onClick={() => setSourceFilter("embed")}
                                    title="Embedded media"
                                >
                                    Embed ({embedCount})
                                </button>
                            )}
                            {linkCount > 0 && (
                                <button
                                    className={`vc-media-filter-btn small ${sourceFilter === "link" ? "active" : ""}`}
                                    onClick={() => setSourceFilter("link")}
                                    title="Media from links"
                                >
                                    Link ({linkCount})
                                </button>
                            )}
                            {forwardCount > 0 && (
                                <button
                                    className={`vc-media-filter-btn small ${sourceFilter === "forward" ? "active" : ""}`}
                                    onClick={() => setSourceFilter("forward")}
                                    title="Forwarded messages"
                                >
                                    Forward ({forwardCount})
                                </button>
                            )}
                        </div>

                        <button
                            className={`vc-media-filter-btn vc-media-find-duplicates-btn ${isScanning ? "scanning" : ""}`}
                            onClick={handleFindDuplicates}
                            disabled={isScanning || isLoadingAll || imageCount === 0}
                            title="Find duplicate images in the current results"
                        >
                            {isScanning ? (
                                <>
                                    <span className="vc-media-loading-spinner"></span>
                                    {scanProgress.current}/{scanProgress.total}
                                </>
                            ) : (
                                <>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                                    </svg>
                                    Find Duplicates
                                </>
                            )}
                        </button>
                    </>
                )}

                <ModalCloseButton onClick={onClose} />
            </ModalHeader>

            <ModalContent className="vc-media-modal-content">
                <div className={`vc-media-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
                    {/* Date Sidebar */}
                    {view === "gallery" && (
                        <div className={`vc-media-sidebar-wrapper ${sidebarCollapsed ? "collapsed" : ""}`}>
                            <button
                                className="vc-media-sidebar-toggle"
                                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                                title={sidebarCollapsed ? "Show dates" : "Hide dates"}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                    {sidebarCollapsed ? (
                                        <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                                    ) : (
                                        <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
                                    )}
                                </svg>
                            </button>
                            {!sidebarCollapsed && (
                                <DateSidebar
                                    dateGroups={dateGroups}
                                    selectedDate={selectedDate}
                                    onSelectDate={setSelectedDate}
                                    totalCount={items.length}
                                />
                            )}
                        </div>
                    )}

                    {/* Main Content */}
                    <div className="vc-media-main-content">
                        {isLoadingAll && view === "gallery" && (
                            <div className="vc-media-loading-banner">
                                <span className="vc-media-loading-spinner"></span>
                                Loading more results... ({items.length} of {totalResults})
                            </div>
                        )}

                        {view === "gallery" ? (
                            <>
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
                                            {selectedDate ? "No media found for this date" : "No media found"}
                                        </div>
                                    )}
                                </div>

                                {/* Helpful tip at the bottom */}
                                {!isLoadingAll && totalResults > items.length && (
                                    <div className="vc-media-tip">
                                        <span>Some results may not have loaded automatically. Scroll down in Discord's search to load more.</span>
                                    </div>
                                )}
                                {!isLoadingAll && totalResults <= items.length && items.length > 0 && (
                                    <div className="vc-media-tip">
                                        <span>All {items.length} media items loaded</span>
                                    </div>
                                )}
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
    );
}

// ============ MODAL MANAGEMENT ============

function openMediaModal() {
    if (currentMediaItems.length === 0) return;

    currentModalKey = openModal(props => (
        <MediaGridModal
            modalProps={props}
            mediaItems={currentMediaItems}
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

function injectToggleButton() {
    const existingBtn = document.querySelector("#vc-media-grid-toggle");
    if (existingBtn) {
        // Update count and loading state on existing button
        const countText = totalResults > currentMediaItems.length
            ? `${currentMediaItems.length}/${totalResults}`
            : `${currentMediaItems.length}`;

        if (isLoadingAll) {
            existingBtn.className = "vc-media-grid-toggle-btn loading";
            existingBtn.innerHTML = `
                <span class="vc-media-loading-spinner"></span>
                Loading... (${countText})
            `;
        } else {
            existingBtn.className = "vc-media-grid-toggle-btn";
            existingBtn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M4 4h4v4H4V4zm6 0h4v4h-4V4zm6 0h4v4h-4V4zM4 10h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4zM4 16h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4z"/>
                </svg>
                Grid View (${countText})
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
            searchHeader = searchResults.closest('[class*="container"]')?.querySelector('[class*="header"]') || null;
        }
    }

    if (!searchHeader) return;

    const toggleBtn = document.createElement("button");
    toggleBtn.id = "vc-media-grid-toggle";
    toggleBtn.className = "vc-media-grid-toggle-btn";
    toggleBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24">
            <path fill="currentColor" d="M4 4h4v4H4V4zm6 0h4v4h-4V4zm6 0h4v4h-4V4zM4 10h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4zM4 16h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4z"/>
        </svg>
        Grid View (${currentMediaItems.length})
    `;
    toggleBtn.title = "Open Media Grid";
    toggleBtn.onclick = openMediaModal;

    searchHeader.appendChild(toggleBtn);
}

function removeToggleButton() {
    document.querySelector("#vc-media-grid-toggle")?.remove();
}

// ============ SEARCH RESULT FETCHING ============

async function fetchAllSearchResults(guildId: string, initialMessages: any[], totalCount: number, searchData: any): Promise<void> {
    if (isLoadingAll) return;
    isLoadingAll = true;

    // Update button to show loading state
    injectToggleButton();

    try {
        const firstData = searchData.data?.[0];
        if (!firstData) {
            console.log("[BetterMediaSearch] No firstData found");
            return;
        }

        // Get the channel ID from the messages
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

        // Detect media type
        let hasImage = false;
        let hasVideo = false;
        for (const msgGroup of initialMessages) {
            for (const msg of msgGroup) {
                for (const att of msg.attachments || []) {
                    const ct = att.content_type || "";
                    if (ct.startsWith("image/") || /\.(png|jpg|jpeg|gif|webp)$/i.test(att.filename || "")) {
                        hasImage = true;
                    }
                    if (ct.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(att.filename || "")) {
                        hasVideo = true;
                    }
                }
            }
        }

        const limit = 25;
        let offset = limit;
        const maxResults = settings.store.maxResults;

        while (offset < totalCount && offset < maxResults) {
            try {
                const searchUrl = `/guilds/${guildId}/messages/search`;
                const queryParams: Record<string, any> = {
                    offset: offset,
                    include_nsfw: true
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

                const response = await RestAPI.get({
                    url: searchUrl,
                    query: queryParams
                });

                if (response.body?.messages && response.body.messages.length > 0) {
                    const newItems = extractMediaFromMessages(response.body.messages, guildId);

                    const existingIds = new Set(currentMediaItems.map(item => `${item.messageId}-${item.url}`));
                    const uniqueNewItems = newItems.filter(item => !existingIds.has(`${item.messageId}-${item.url}`));

                    if (uniqueNewItems.length > 0) {
                        currentMediaItems = [...currentMediaItems, ...uniqueNewItems];
                        injectToggleButton();
                    }

                    if (response.body.messages.length < limit) {
                        break;
                    }
                } else {
                    break;
                }

                offset += limit;
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (error) {
                console.error("[BetterMediaSearch] Error fetching page:", error);
                break;
            }
        }
    } finally {
        isLoadingAll = false;
        injectToggleButton();
    }
}

function handleSearchResults(data: any) {
    let messages = data.messages || data.body?.messages || data.result?.messages;
    const guildId = data.guildId;
    const channelId = data.channelId;

    let searchData = null;
    let foundTotalResults = 0;

    if (!messages && data.data && Array.isArray(data.data) && data.data[0]) {
        const firstData = data.data[0];
        messages = firstData.messages;
        searchData = data;

        foundTotalResults = firstData.total_results ||
                           firstData.totalResults ||
                           data.total_results ||
                           data.totalResults ||
                           firstData.hit_count ||
                           0;

        totalResults = foundTotalResults;
    }

    if (!messages && data.searchResult?.messages) {
        messages = data.searchResult.messages;
    }

    if (!messages && Array.isArray(data) && data.length > 0) {
        messages = data;
    }

    if (messages && messages.length > 0) {
        if (guildId) currentGuildId = guildId;
        if (channelId) currentChannelId = channelId;

        if (!currentChannelId && messages[0]?.[0]?.channel_id) {
            currentChannelId = messages[0][0].channel_id;
        }

        const newItems = extractMediaFromMessages(messages, guildId);

        const existingIds = new Set(currentMediaItems.map(item => `${item.messageId}-${item.url}`));
        const uniqueNewItems = newItems.filter(item => !existingIds.has(`${item.messageId}-${item.url}`));

        if (currentMediaItems.length === 0) {
            currentMediaItems = newItems;
        } else if (uniqueNewItems.length > 0) {
            currentMediaItems = [...currentMediaItems, ...uniqueNewItems];
        }

        setTimeout(() => {
            injectToggleButton();
            if (settings.store.autoOpen && currentMediaItems.length > 0) {
                openMediaModal();
            }
        }, 300);

        if (totalResults > currentMediaItems.length && guildId && searchData) {
            fetchAllSearchResults(guildId, messages, totalResults, searchData);
        }
    }
}

function cleanup() {
    closeMediaModal();
    removeToggleButton();
    currentMediaItems = [];
    isLoadingAll = false;
    currentGuildId = "";
    currentChannelId = "";
    totalResults = 0;
}

// ============ PLUGIN EXPORT ============

export default definePlugin({
    name: "BetterMediaSearch",
    description: "Grid view for media in Discord search results with duplicate detection. Search with has:image or has:video, then click Grid View.",
    authors: [{ name: "aorer.", id: 0n }],
    settings,

    flux: {
        SEARCH_FINISH: handleSearchResults,
        SEARCH_MESSAGES_SUCCESS: handleSearchResults,
        SEARCH_CLEAR: cleanup,
        SEARCH_MESSAGES_CLEAR_ALL: cleanup,
        CHANNEL_SELECT() {
            closeMediaModal();
        }
    },

    start() { },
    stop() { cleanup(); }
});
