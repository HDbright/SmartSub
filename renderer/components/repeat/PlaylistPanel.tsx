import React, { useMemo, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import {
  ArrowDownAZ,
  AudioLines,
  ListMusic,
  ListVideo,
  Pencil,
  Play,
  Plus,
  Repeat1,
  Repeat,
  Square,
  Trash2,
  Video as VideoIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyState } from '@/components/EmptyState';
import { cn } from 'lib/utils';
import { useContextMenu } from './RepeatContextMenu';
import { PromptDialog, MediaMetaDialog } from './dialogs';
import type { RepeatMediaContext } from './MediaLibraryPanel';
import {
  addMediaEntry,
  addMediaToPlaylist,
  createPlaylist,
  removeMediaFromPlaylist,
  removePlaylist,
  renameMedia,
  renamePlaylist,
  sortIdsByName,
  type LibMedia,
  type PlaylistData,
} from './mediaLibrary';

export type MediaPlayMode = 'once' | 'loopList' | 'loopOne';

interface PanelProps {
  ctx: RepeatMediaContext;
  playMode: MediaPlayMode;
  onPlayModeChange: (mode: MediaPlayMode) => void;
  /** 按队列播放：paths 为解析后的媒体路径，index 为起始位置 */
  onPlayQueue: (paths: string[], index: number, mode: MediaPlayMode) => void;
  /** 当前媒体队列状态（用于指示与停止） */
  queueInfo: { count: number; index: number } | null;
  onStopQueue: () => void;
}

/** 播放列表面板：自建分组管理媒体，支持顺序播放 / 列表循环 / 单曲循环 */
export default function PlaylistPanel({
  ctx,
  playMode,
  onPlayModeChange,
  onPlayQueue,
  queueInfo,
  onStopQueue,
}: PanelProps) {
  const { t } = useTranslation('repeat');
  const {
    library,
    setLibrary,
    playlists,
    setPlaylists,
    currentMediaPath,
    onPlayMedia,
  } = ctx;
  const { openMenu, menuElement } = useContextMenu();

  const [selectedId, setSelectedId] = useState<string | null>(
    playlists[0]?.id ?? null,
  );
  const [sortByName, setSortByName] = useState(false);
  const [prompt, setPrompt] = useState<
    { kind: 'newGroup' } | { kind: 'renameGroup'; id: string } | null
  >(null);
  const [metaTarget, setMetaTarget] = useState<LibMedia | null>(null);

  const selected: PlaylistData | undefined =
    playlists.find((p) => p.id === selectedId) || playlists[0];

  const itemIds = useMemo(() => {
    if (!selected) return [];
    return sortByName
      ? sortIdsByName(library.media, selected.mediaIds)
      : selected.mediaIds;
  }, [selected, library.media, sortByName]);

  /** 分组内媒体解析出的可播放路径（注册项被删的跳过） */
  const playablePaths = useMemo(
    () =>
      (selected?.mediaIds || [])
        .map((id) => library.media[id]?.path)
        .filter((p): p is string => Boolean(p)),
    [selected, library.media],
  );

  const playlistMenu = (pl: PlaylistData) => [
    {
      key: 'rename',
      label: t('playlist.rename'),
      icon: Pencil,
      onSelect: () => setPrompt({ kind: 'renameGroup', id: pl.id }),
    },
    {
      key: 'delete',
      label: t('playlist.delete'),
      icon: Trash2,
      danger: true,
      onSelect: () => {
        setPlaylists(removePlaylist(playlists, pl.id));
        if (selectedId === pl.id) setSelectedId(null);
      },
    },
  ];

  const itemMenu = (media: LibMedia) => [
    {
      key: 'play',
      label: t('playlist.play'),
      icon: Play,
      onSelect: () => onPlayMedia(media.path),
    },
    {
      key: 'meta',
      label: t('library.editMeta'),
      icon: Pencil,
      onSelect: () => setMetaTarget(media),
    },
    {
      key: 'remove',
      label: t('playlist.removeFromList'),
      icon: Trash2,
      danger: true,
      onSelect: () => {
        if (!selected) return;
        setPlaylists(removeMediaFromPlaylist(playlists, selected.id, media.id));
      },
    },
  ];

  if (!playlists.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Button
          variant="ghost"
          size="sm"
          className="mb-1 h-6 self-start gap-1 px-1.5 text-[11px]"
          onClick={() => setPrompt({ kind: 'newGroup' })}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('playlist.newGroup')}
        </Button>
        <EmptyState
          icon={ListVideo}
          title={t('playlist.empty')}
          description={t('playlist.emptyDesc')}
          className="flex-1 justify-center"
        />
        <PromptDialog
          open={prompt?.kind === 'newGroup'}
          title={t('playlist.newGroup')}
          onSubmit={(value) => setPlaylists(createPlaylist(playlists, value))}
          onClose={() => setPrompt(null)}
        />
        {menuElement}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-2">
      {/* 左：分组列表 */}
      <div className="flex w-32 flex-shrink-0 flex-col gap-0.5 overflow-y-auto pr-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="mb-0.5 h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          onClick={() => setPrompt({ kind: 'newGroup' })}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('playlist.newGroup')}
        </Button>
        {playlists.map((pl) => (
          <button
            key={pl.id}
            type="button"
            onClick={() => setSelectedId(pl.id)}
            onContextMenu={(e) => openMenu(e, playlistMenu(pl))}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent',
              selected?.id === pl.id
                ? 'bg-primary/10 font-medium text-primary'
                : '',
            )}
          >
            <ListMusic className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate">{pl.name}</span>
            <span className="flex-shrink-0 text-[10px] text-faint tnum">
              {pl.mediaIds.length}
            </span>
          </button>
        ))}
      </div>

      {/* 右：分组内容 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-1 flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={!playablePaths.length}
            onClick={() => selected && onPlayQueue(playablePaths, 0, playMode)}
          >
            <Play className="h-3 w-3" />
            {t('playlist.playList')}
          </Button>
          <Select
            value={playMode}
            onValueChange={(v) => onPlayModeChange(v as MediaPlayMode)}
          >
            <SelectTrigger
              className="h-6 w-[92px] text-[11px]"
              aria-label={t('playlist.playMode')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="once">
                <span className="flex items-center gap-1.5">
                  <ListVideo className="h-3 w-3" />
                  {t('playlist.modeOnce')}
                </span>
              </SelectItem>
              <SelectItem value="loopList">
                <span className="flex items-center gap-1.5">
                  <Repeat className="h-3 w-3" />
                  {t('playlist.modeLoopList')}
                </span>
              </SelectItem>
              <SelectItem value="loopOne">
                <span className="flex items-center gap-1.5">
                  <Repeat1 className="h-3 w-3" />
                  {t('playlist.modeLoopOne')}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px]"
            disabled={!currentMediaPath}
            title={t('playlist.addCurrent')}
            onClick={() => {
              if (!selected || !currentMediaPath) return;
              // 复用媒体注册表：已收藏的沿用其 id，未收藏的先注册（不进分类）
              const { data: withMedia, id } = addMediaEntry(
                library,
                currentMediaPath,
              );
              setLibrary(withMedia);
              setPlaylists(addMediaToPlaylist(playlists, selected.id, id));
              toast.success(t('playlist.added'));
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('playlist.addCurrent')}
          </Button>
          <span className="flex-1" />
          {queueInfo && (
            <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
              <span className="tnum">
                {t('playlist.playing', {
                  index: queueInfo.index + 1,
                  count: queueInfo.count,
                })}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-5 gap-0.5 px-1 text-[10px]"
                onClick={onStopQueue}
              >
                <Square className="h-2.5 w-2.5" />
                {t('list.stop')}
              </Button>
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-6 w-6',
              sortByName ? 'text-primary' : 'text-muted-foreground',
            )}
            title={
              sortByName ? t('library.sortByAdded') : t('library.sortByName')
            }
            onClick={() => setSortByName((v) => !v)}
          >
            <ArrowDownAZ className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {itemIds.map((id) => {
            const media = library.media[id];
            if (!media) return null;
            return (
              <div
                key={id}
                onClick={() => {
                  // 按当前分组顺序播放（跳过的失效项不影响定位：以可播放路径为准）
                  const idx = playablePaths.indexOf(media.path);
                  if (idx >= 0) onPlayQueue(playablePaths, idx, playMode);
                }}
                onContextMenu={(e) => openMenu(e, itemMenu(media))}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent',
                  currentMediaPath === media.path &&
                    'bg-primary/10 text-primary',
                )}
              >
                {media.kind === 'audio' ? (
                  <AudioLines className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <VideoIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate" title={media.path}>
                  {media.name}
                </span>
              </div>
            );
          })}
          {!itemIds.length && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t('playlist.emptyList')}
            </p>
          )}
        </div>
      </div>

      {menuElement}

      <PromptDialog
        open={prompt?.kind === 'newGroup' || prompt?.kind === 'renameGroup'}
        title={
          prompt?.kind === 'renameGroup'
            ? t('playlist.rename')
            : t('playlist.newGroup')
        }
        initialValue={
          prompt?.kind === 'renameGroup'
            ? playlists.find((p) => p.id === prompt.id)?.name || ''
            : ''
        }
        onSubmit={(value) => {
          if (!prompt) return;
          if (prompt.kind === 'newGroup') {
            const next = createPlaylist(playlists, value);
            setPlaylists(next);
            setSelectedId(next[next.length - 1].id);
          } else {
            setPlaylists(renamePlaylist(playlists, prompt.id, value));
          }
        }}
        onClose={() => setPrompt(null)}
      />

      <MediaMetaDialog
        open={metaTarget != null}
        media={metaTarget}
        onSubmit={(id, name) => {
          setLibrary(renameMedia(library, id, name));
          toast.success(t('meta.saved'));
        }}
        onClose={() => setMetaTarget(null)}
      />
    </div>
  );
}
