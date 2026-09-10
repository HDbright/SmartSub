import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import {
  ListVideo,
  ListMusic,
  ArrowDownAZ,
  Disc,
  Tag,
  AudioLines,
  ChevronRight,
  Folder,
  FolderMinus,
  FolderOpen,
  FileText,
  Pencil,
  Play,
  Plus,
  Star,
  Trash2,
  Video as VideoIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
import { useMediaTagNames } from './useMediaTagNames';
import {
  addCategory,
  addMediaToPlaylist,
  deleteMediaEntry,
  favoriteMedia,
  findCategory,
  removeCategory,
  removeMediaFromCategory,
  renameCategory,
  renameMedia,
  sortIdsByName,
  type LibCategory,
  type LibMedia,
  type MediaNameMode,
  type LibraryData,
  type PlaylistData,
} from './mediaLibrary';

export interface RepeatMediaContext {
  library: LibraryData;
  setLibrary: React.Dispatch<React.SetStateAction<LibraryData>>;
  playlists: PlaylistData[];
  setPlaylists: React.Dispatch<React.SetStateAction<PlaylistData[]>>;
  currentMediaPath: string | null;
  /** 播放单个媒体文件（不带播放列表队列） */
  onPlayMedia: (path: string) => void;
  /** 打开媒体属性查看弹窗 */
  onShowProperties: (filePath: string) => void;
}

interface PanelProps {
  ctx: RepeatMediaContext;
  /** 当前选中的分类（收藏/拖拽导入的目标；null = 未分类） */
  selectedCatId: string | null;
  onSelectCategory: (id: string | null) => void;
  /** 列表文件名显示模式 */
  nameMode: MediaNameMode;
  onNameModeChange: (mode: MediaNameMode) => void;
}

/** 树状媒体库：分类目录 + 收藏的音视频，右键增删改查；列表可按元信息名称排序 */
export default function MediaLibraryPanel({
  ctx,
  selectedCatId,
  onSelectCategory,
  nameMode,
  onNameModeChange,
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
  const { onShowProperties } = ctx;

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sortByName, setSortByName] = useState(false);
  const [prompt, setPrompt] = useState<
    | { kind: 'newCategory'; parentId: string | null }
    | { kind: 'renameCategory'; id: string }
    | null
  >(null);
  const [metaTarget, setMetaTarget] = useState<LibMedia | null>(null);
  const [picker, setPicker] = useState<
    | { kind: 'moveToCategory'; mediaId: string }
    | { kind: 'addToPlaylist'; mediaId: string }
    | null
  >(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');

  const orderedRoot = useMemo(
    () =>
      sortByName
        ? sortIdsByName(library.media, library.rootMediaIds)
        : library.rootMediaIds,
    [library, sortByName],
  );

  const mediaById = (id: string): LibMedia | undefined => library.media[id];

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ---------- 分类右键 ----------
  const categoryMenu = (cat: LibCategory) => [
    {
      key: 'newSub',
      label: t('library.newSubcategory'),
      icon: Plus,
      onSelect: () => setPrompt({ kind: 'newCategory', parentId: cat.id }),
    },
    {
      key: 'rename',
      label: t('library.rename'),
      icon: Pencil,
      onSelect: () => setPrompt({ kind: 'renameCategory', id: cat.id }),
    },
    {
      key: 'delete',
      label: t('library.delete'),
      icon: Trash2,
      danger: true,
      onSelect: () => {
        const { data, removedMediaIds } = removeCategory(library, cat.id);
        setLibrary({
          ...data,
          media: pruneMedia(data.media, removedMediaIds, playlists),
        });
        toast.success(t('library.deleted'));
      },
    },
  ];

  // ---------- 媒体右键 ----------
  const mediaMenu = (media: LibMedia, categoryId: string | null) => [
    {
      key: 'play',
      label: t('library.play'),
      icon: Play,
      onSelect: () => onPlayMedia(media.path),
    },
    {
      key: 'reveal',
      label: t('prop.openLocation'),
      icon: FolderOpen,
      onSelect: () =>
        void window?.ipc?.invoke('mediaFile:reveal', { filePath: media.path }),
    },
    {
      key: 'meta',
      label: t('library.editMeta'),
      icon: Pencil,
      onSelect: () => setMetaTarget(media),
    },
    {
      key: 'move',
      label: t('library.moveToCategory'),
      icon: Folder,
      onSelect: () => setPicker({ kind: 'moveToCategory', mediaId: media.id }),
    },
    {
      key: 'toPlaylist',
      label: t('library.addToPlaylist'),
      icon: ListVideo,
      ...(playlists.length
        ? {
            children: playlists.map((p) => ({
              key: `toPl-${p.id}`,
              label: `${p.name} (${p.mediaIds.length})`,
              icon: ListMusic,
              onSelect: () => {
                setPlaylists(addMediaToPlaylist(playlists, p.id, media.id));
                toast.success(t('playlist.added'));
              },
            })),
          }
        : {
            // 还没有播放列表：退回弹窗（内含新建输入框）
            onSelect: () =>
              setPicker({ kind: 'addToPlaylist', mediaId: media.id }),
          }),
    },
    {
      key: 'removeFromCat',
      label: t('library.removeFromCategory'),
      icon: Star,
      danger: true,
      onSelect: () => {
        setLibrary(
          garbagePass(removeMediaFromCategory(library, categoryId, media.id)),
        );
      },
    },
    {
      key: 'deleteAll',
      label: t('library.deleteFromLibrary'),
      icon: Trash2,
      danger: true,
      onSelect: () => {
        // 从所有分类与播放列表移除引用，再删除注册项
        let next = { ...library };
        next.rootMediaIds = next.rootMediaIds.filter((m) => m !== media.id);
        const strip = (nodes: LibCategory[]): LibCategory[] =>
          nodes.map((n) => ({
            ...n,
            mediaIds: n.mediaIds.filter((m) => m !== media.id),
            children: strip(n.children),
          }));
        next.categories = strip(next.categories);
        next = deleteMediaEntry(next, media.id);
        setPlaylists((prev) =>
          prev.map((p) => ({
            ...p,
            mediaIds: p.mediaIds.filter((m) => m !== media.id),
          })),
        );
        setLibrary(next);
      },
    },
    {
      key: 'props',
      label: t('prop.menuItem'),
      icon: FileText,
      onSelect: () => onShowProperties(media.path),
    },
  ];

  /** 引用清理后回收无主媒体注册项 */
  const garbagePass = (data: LibraryData): LibraryData => {
    const referenced = new Set<string>();
    playlists.forEach((p) => p.mediaIds.forEach((id) => referenced.add(id)));
    data.categories.forEach(function walk(n) {
      n.mediaIds.forEach((id) => referenced.add(id));
      n.children.forEach(walk);
    });
    data.rootMediaIds.forEach((id) => referenced.add(id));
    const media: Record<string, LibMedia> = {};
    Object.values(data.media).forEach((m) => {
      if (referenced.has(m.id)) media[m.id] = m;
    });
    return { ...data, media };
  };

  const pruneMedia = (
    media: LibraryData['media'],
    removedIds: string[],
    pls: PlaylistData[],
  ): LibraryData['media'] => {
    const referenced = new Set<string>();
    pls.forEach((p) => p.mediaIds.forEach((id) => referenced.add(id)));
    const next = { ...media };
    removedIds.forEach((id) => {
      if (!referenced.has(id)) delete next[id];
    });
    return next;
  };

  // 内嵌标签（title/album）探测缓存，供标签类显示模式回退到文件名前使用
  const allMediaPaths = useMemo(
    () => Object.values(library.media).map((m) => m.path),
    [library.media],
  );
  const tagNames = useMediaTagNames(allMediaPaths);

  const basename = (p: string) =>
    p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);

  /** 按当前显示模式取行的展示名 */
  const displayLabel = (m: LibMedia): string => {
    const file = basename(m.path);
    switch (nameMode) {
      case 'fileName':
        return file;
      case 'tagTitle':
        return tagNames[m.path]?.title || file;
      case 'tagAlbum':
        return tagNames[m.path]?.album || file;
      default:
        return m.name;
    }
  };

  // ---------- 渲染 ----------
  const isEmpty = !library.categories.length && !library.rootMediaIds.length;

  const renderMediaRow = (media: LibMedia, categoryId: string | null) => (
    <div
      key={media.id}
      onDoubleClick={() => onPlayMedia(media.path)}
      onClick={() => onPlayMedia(media.path)}
      onContextMenu={(e) => openMenu(e, mediaMenu(media, categoryId))}
      className={cn(
        'group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2 pr-1 text-xs transition-colors hover:bg-accent',
        currentMediaPath === media.path && 'bg-primary/10 text-primary',
      )}
      style={{ paddingLeft: 8 }}
    >
      {media.kind === 'audio' ? (
        <AudioLines className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      ) : (
        <VideoIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate" title={media.path}>
        {displayLabel(media)}
      </span>
      <span
        className="opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          openMenu(
            e as unknown as React.MouseEvent,
            mediaMenu(media, categoryId),
          );
        }}
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-muted-foreground"
          aria-label={t('library.more')}
        >
          <ListVideo className="h-3.5 w-3.5" />
        </Button>
      </span>
    </div>
  );

  const renderCategory = (cat: LibCategory, depth: number) => {
    const isCollapsed = collapsed.has(cat.id);
    const ids = sortByName
      ? sortIdsByName(library.media, cat.mediaIds)
      : cat.mediaIds;
    return (
      <div key={cat.id}>
        <div
          onClick={() => onSelectCategory(cat.id)}
          onContextMenu={(e) => openMenu(e, categoryMenu(cat))}
          className={cn(
            'flex cursor-pointer items-center gap-1 rounded-md py-1 pr-1 text-xs font-medium transition-colors hover:bg-accent',
            selectedCatId === cat.id && 'bg-primary/10 text-primary',
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          <ChevronRight
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(cat.id);
            }}
            className={cn(
              'h-3.5 w-3.5 flex-shrink-0 cursor-pointer text-muted-foreground transition-transform',
              !isCollapsed && 'rotate-90',
            )}
          />
          {isCollapsed ? (
            <Folder className="h-3.5 w-3.5 flex-shrink-0 text-amber-500/80" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-amber-500/80" />
          )}
          <span className="min-w-0 flex-1 truncate">{cat.name}</span>
          <span className="flex-shrink-0 text-[10px] text-faint tnum">
            {cat.mediaIds.length || ''}
          </span>
        </div>
        {!isCollapsed && (
          <div>
            {ids.map((id) => {
              const media = mediaById(id);
              return media ? renderMediaRow(media, cat.id) : null;
            })}
            {cat.children.map((child) => renderCategory(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // ---- 拖拽导入：媒体文件放入选中分类（未选中则入未分类），字幕文件忽略 ----
  const [libDragOver, setLibDragOver] = useState(false);
  const libDragDepth = useRef(0);

  const handleLibDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    libDragDepth.current += 1;
    setLibDragOver(true);
  };
  const handleLibDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleLibDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    libDragDepth.current = Math.max(0, libDragDepth.current - 1);
    if (libDragDepth.current === 0) setLibDragOver(false);
  };
  const handleLibDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    libDragDepth.current = 0;
    setLibDragOver(false);
    const paths: string[] = [];
    const dropped = e.dataTransfer.files;
    for (let i = 0; i < dropped.length; i++) {
      const p =
        window?.ipc?.getPathForFile?.(dropped[i]) ??
        (dropped[i] as unknown as { path?: string }).path;
      if (p) paths.push(p);
    }
    if (!paths.length) return;
    try {
      const wrapped = (await window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: 'media',
      })) as { filePath: string }[];
      const mediaOnly = (wrapped || []).filter(
        (f) =>
          !['srt', 'vtt', 'ass', 'ssa', 'lrc'].includes(
            (f.filePath.split('.').pop() || '').toLowerCase(),
          ),
      );
      if (!mediaOnly.length) return;
      let next = library;
      mediaOnly.forEach((f) => {
        next = favoriteMedia(next, f.filePath, selectedCatId).data;
      });
      setLibrary(next);
      toast.success(t('library.dropAdded', { n: mediaOnly.length }));
    } catch {
      /* 忽略 */
    }
  };

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        libDragOver && 'rounded-md ring-2 ring-primary/50',
      )}
      onDragEnter={handleLibDragEnter}
      onDragOver={handleLibDragOver}
      onDragLeave={handleLibDragLeave}
      onDrop={handleLibDrop}
    >
      {/* 工具行 */}
      <div className="mb-1 flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={() => setPrompt({ kind: 'newCategory', parentId: null })}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('library.newCategory')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          disabled={!currentMediaPath}
          onClick={() => {
            if (!currentMediaPath) return;
            setLibrary(
              favoriteMedia(library, currentMediaPath, selectedCatId).data,
            );
            const label = selectedCatId
              ? findCategory(library.categories, selectedCatId)?.name ||
                t('library.unfiled')
              : t('library.unfiled');
            toast.success(t('fav.assigned', { label }));
          }}
        >
          <Star className="h-3.5 w-3.5" />
          {t('library.favoriteCurrent')}
        </Button>
        <span className="flex-1" />
        {/* 文件名显示模式：纯图标 + 悬浮提示 */}
        <Select
          value={nameMode}
          onValueChange={(v) => onNameModeChange(v as MediaNameMode)}
        >
          <SelectTrigger
            className="h-6 w-8 px-1.5 text-[11px]"
            title={t('library.nameMode')}
            aria-label={t('library.nameMode')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-0">
            <SelectItem value="custom" title={t('library.nameCustom')}>
              <Pencil className="h-3.5 w-3.5" />
            </SelectItem>
            <SelectItem value="fileName" title={t('library.nameFileName')}>
              <FileText className="h-3.5 w-3.5" />
            </SelectItem>
            <SelectItem value="tagTitle" title={t('library.nameTagTitle')}>
              <Tag className="h-3.5 w-3.5" />
            </SelectItem>
            <SelectItem value="tagAlbum" title={t('library.nameTagAlbum')}>
              <Disc className="h-3.5 w-3.5" />
            </SelectItem>
          </SelectContent>
        </Select>
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

      {isEmpty ? (
        <EmptyState
          icon={Star}
          title={t('library.empty')}
          description={t('library.emptyDesc')}
          className="flex-1 justify-center"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {orderedRoot.length > 0 && (
            <div>
              <div
                onClick={() => onSelectCategory(null)}
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded-md px-1 py-1 text-xs font-medium transition-colors hover:bg-accent',
                  selectedCatId === null && 'bg-primary/10 text-primary',
                )}
              >
                <Star className="h-3.5 w-3.5" />
                {t('library.unfiled')}
              </div>
              {orderedRoot.map((id) => {
                const media = mediaById(id);
                return media ? renderMediaRow(media, null) : null;
              })}
            </div>
          )}
          {library.categories.map((cat) => renderCategory(cat, 0))}
        </div>
      )}

      {menuElement}

      {/* 新建/重命名分类 */}
      <PromptDialog
        open={prompt != null}
        title={
          prompt?.kind === 'renameCategory'
            ? t('library.rename')
            : t('library.newCategory')
        }
        initialValue={
          prompt?.kind === 'renameCategory'
            ? findCategory(library.categories, prompt.id)?.name || ''
            : ''
        }
        onSubmit={(value) => {
          if (!prompt) return;
          if (prompt.kind === 'newCategory') {
            setLibrary(addCategory(library, prompt.parentId, value));
          } else {
            setLibrary(renameCategory(library, prompt.id, value));
          }
        }}
        onClose={() => setPrompt(null)}
      />

      {/* 元信息编辑 */}
      <MediaMetaDialog
        open={metaTarget != null}
        media={metaTarget}
        onSubmit={(id, name) => {
          setLibrary(renameMedia(library, id, name));
          toast.success(t('meta.saved'));
        }}
        onClose={() => setMetaTarget(null)}
      />

      {/* 移动到分类 / 添加到播放列表 选择弹窗 */}
      <Dialog open={picker != null} onOpenChange={(o) => !o && setPicker(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-base">
              {picker?.kind === 'moveToCategory'
                ? t('library.moveToCategory')
                : t('library.addToPlaylist')}
            </DialogTitle>
          </DialogHeader>
          {picker?.kind === 'moveToCategory' ? (
            <div className="max-h-64 space-y-0.5 overflow-y-auto">
              <PickerRow
                label={t('library.unfiled')}
                onClick={() => {
                  setLibrary(
                    favoriteMedia(
                      library,
                      library.media[picker.mediaId].path,
                      null,
                    ).data,
                  );
                  setPicker(null);
                }}
              />
              <FlatCategories
                categories={library.categories}
                render={(cat) => (
                  <PickerRow
                    key={cat.id}
                    label={cat.name}
                    depth={cat.depth}
                    onClick={() => {
                      setLibrary(
                        favoriteMedia(
                          library,
                          library.media[picker.mediaId].path,
                          cat.id,
                        ).data,
                      );
                      setPicker(null);
                    }}
                  />
                )}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <div className="max-h-44 space-y-0.5 overflow-y-auto">
                {playlists.map((p) => (
                  <PickerRow
                    key={p.id}
                    label={`${p.name} (${p.mediaIds.length})`}
                    onClick={() => {
                      setPlaylists(
                        addMediaToPlaylist(
                          playlists,
                          p.id,
                          (picker as { mediaId: string }).mediaId,
                        ),
                      );
                      toast.success(t('playlist.added'));
                      setPicker(null);
                    }}
                  />
                ))}
                {!playlists.length && (
                  <p className="py-2 text-center text-xs text-muted-foreground">
                    {t('playlist.empty')}
                  </p>
                )}
              </div>
              <div className="flex gap-1.5">
                <Input
                  className="h-7 text-xs"
                  placeholder={t('playlist.newGroup')}
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                />
                <Button
                  size="sm"
                  className="h-7"
                  disabled={!newPlaylistName.trim()}
                  onClick={() => {
                    const name = newPlaylistName.trim();
                    const id = `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                    setPlaylists([
                      ...playlists,
                      {
                        id,
                        name,
                        mediaIds: [
                          picker!.kind === 'addToPlaylist'
                            ? (picker as { mediaId: string }).mediaId
                            : '',
                        ],
                        createdAt: Date.now(),
                      },
                    ]);
                    setNewPlaylistName('');
                    toast.success(t('playlist.added'));
                    setPicker(null);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PickerRow({
  label,
  depth = 0,
  onClick,
}: {
  label: string;
  depth?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

/** 展平分类树（带深度） */
function FlatCategories({
  categories,
  render,
}: {
  categories: LibCategory[];
  render: (cat: LibCategory & { depth: number }) => React.ReactNode;
}) {
  const out: (LibCategory & { depth: number })[] = [];
  const walk = (nodes: LibCategory[], depth: number) => {
    nodes.forEach((n) => {
      out.push({ ...n, depth });
      walk(n.children, depth + 1);
    });
  };
  walk(categories, 0);
  return <>{out.map((cat) => render(cat))}</>;
}
