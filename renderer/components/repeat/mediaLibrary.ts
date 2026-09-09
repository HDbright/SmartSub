import { useEffect, useRef, useState } from 'react';
import { isAudioPath } from 'lib/utils';

/**
 * 复读页媒体库 / 播放列表 / 最近播放的本地数据层。
 * 元数据量小（仅路径与名称），直接持久化在 localStorage（key 带版本号），
 * 读取全部容错：SSG 预渲染环境无 localStorage 时返回空数据。
 */

export interface LibMedia {
  id: string;
  path: string;
  name: string; // 元信息名称：列表展示与排序用（默认取文件名）
  kind: 'video' | 'audio';
  addedAt: number;
}

export interface LibCategory {
  id: string;
  name: string;
  children: LibCategory[];
  mediaIds: string[];
}

export interface LibraryData {
  categories: LibCategory[];
  rootMediaIds: string[]; // 未分类收藏
  media: Record<string, LibMedia>;
}

export interface PlaylistData {
  id: string;
  name: string;
  mediaIds: string[];
  createdAt: number;
}

export interface RecentMedia {
  path: string;
  name: string;
  kind: 'video' | 'audio';
  playedAt: number;
  subtitlePath?: string;
}

export const LIBRARY_KEY = 'repeatLibraryV1';
export const PLAYLISTS_KEY = 'repeatPlaylistsV1';
export const RECENT_KEY = 'repeatRecentV1';
const RECENT_MAX = 30;

export const emptyLibrary = (): LibraryData => ({
  categories: [],
  rootMediaIds: [],
  media: {},
});

export const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const kindOf = (path: string): 'video' | 'audio' =>
  isAudioPath(path) ? 'audio' : 'video';

export const loadJSON = <T>(key: string, fallback: T): T => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export interface FavoriteGroup {
  id: string;
  name: string;
  color: string;
}

export interface FavoriteCue {
  id: string;
  text: string;
  sourceSubtitle: string; // 出处：字幕文件路径
  videoPath: string; // 关联视频（定位回播）
  start: number;
  end: number;
  createdAt: number;
  groupId: string | null; // 收藏分组
}

export interface RepeatStore {
  library: LibraryData;
  setLibrary: React.Dispatch<React.SetStateAction<LibraryData>>;
  playlists: PlaylistData[];
  setPlaylists: React.Dispatch<React.SetStateAction<PlaylistData[]>>;
  recents: RecentMedia[];
  setRecents: React.Dispatch<React.SetStateAction<RecentMedia[]>>;
  favorites: FavoriteCue[];
  setFavorites: React.Dispatch<React.SetStateAction<FavoriteCue[]>>;
  favGroups: FavoriteGroup[];
  setFavGroups: React.Dispatch<React.SetStateAction<FavoriteGroup[]>>;
}

/**
 * 复读页数据的持久化 hook：SQLite（主进程 sql.js，userData/repeat-library.sqlite3）。
 * 挂载时经 IPC 载入；若库为空且本机存在 localStorage 旧数据（历史版本），一次性迁移入库；
 * 之后任何变更 300ms 防抖整包提交（数据量小，全量重写单事务，简单可靠）。
 */
export function useRepeatStore(): RepeatStore {
  const [library, setLibrary] = useState<LibraryData>(emptyLibrary());
  const [playlists, setPlaylists] = useState<PlaylistData[]>([]);
  const [recents, setRecents] = useState<RecentMedia[]>([]);
  const [favorites, setFavorites] = useState<FavoriteCue[]>([]);
  const [favGroups, setFavGroups] = useState<FavoriteGroup[]>([]);
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // ① 尝试从 SQLite 载入（主进程未重启等场景下通道可能不存在，不阻断迁移）
      let dbData: {
        library: LibraryData;
        playlists: PlaylistData[];
        recents: RecentMedia[];
        favorites: FavoriteCue[];
        favGroups: FavoriteGroup[];
      } | null = null;
      try {
        const res = await window?.ipc?.invoke('repeatLib:load');
        if (res?.success && res.data) dbData = res.data;
      } catch {
        /* 旧主进程无此通道，走下方迁移 */
      }
      if (cancelled) return;
      if (dbData) {
        setLibrary(dbData.library);
        setPlaylists(dbData.playlists || []);
        setRecents(dbData.recents || []);
        setFavorites(dbData.favorites || []);
        setFavGroups(dbData.favGroups || []);
        loadedRef.current = true;
        return;
      }

      // ② SQLite 不可用或为空：一次性迁移本机 localStorage 旧数据。
      //    仅在保存确实成功后才清理 localStorage 键，避免数据丢失。
      const saveOk = async (payload: unknown) => {
        try {
          const res = await window?.ipc?.invoke('repeatLib:saveAll', payload);
          return !!res?.success;
        } catch {
          return false;
        }
      };
      const legacyLib = loadJSON<LibraryData | null>(LIBRARY_KEY, null);
      const legacyPls = loadJSON<PlaylistData[] | null>(PLAYLISTS_KEY, null);
      const legacyRcs = loadJSON<RecentMedia[] | null>(RECENT_KEY, null);
      const hasAny =
        !!(
          legacyLib &&
          (Object.keys(legacyLib.media).length || legacyLib.categories.length)
        ) ||
        !!(legacyPls && legacyPls.length) ||
        !!(legacyRcs && legacyRcs.length);
      const payload = {
        library: legacyLib || emptyLibrary(),
        playlists: legacyPls || [],
        recents: legacyRcs || [],
        favorites: [] as FavoriteCue[],
        favGroups: [] as FavoriteGroup[],
      };
      if (hasAny) {
        setLibrary(payload.library);
        setPlaylists(payload.playlists);
        setRecents(payload.recents);
      }
      if (hasAny && (await saveOk(payload))) {
        [LIBRARY_KEY, PLAYLISTS_KEY, RECENT_KEY].forEach((k) => {
          try {
            window.localStorage.removeItem(k);
          } catch {
            /* 忽略 */
          }
        });
      }
      loadedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 变更防抖整包保存（首次载入完成前不写，避免空数据覆盖）
  useEffect(() => {
    if (!loadedRef.current) return;
    const timer = setTimeout(() => {
      void window?.ipc?.invoke('repeatLib:saveAll', {
        library,
        playlists,
        recents,
        favorites,
        favGroups,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [library, playlists, recents, favorites, favGroups]);

  return {
    library,
    setLibrary,
    playlists,
    setPlaylists,
    recents,
    setRecents,
    favorites,
    setFavorites,
    favGroups,
    setFavGroups,
  };
}

// ----------------------------- 媒体注册表 -----------------------------

/** 收藏媒体文件：按路径去重，返回（新建或既有的）媒体 id。name 默认取文件名。 */
export function addMediaEntry(
  data: LibraryData,
  path: string,
): { data: LibraryData; id: string } {
  const existing = Object.values(data.media).find((m) => m.path === path);
  if (existing) return { data, id: existing.id };
  const id = uid();
  const name = path.slice(
    Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1,
  );
  return {
    data: {
      ...data,
      media: {
        ...data.media,
        [id]: { id, path, name, kind: kindOf(path), addedAt: Date.now() },
      },
    },
    id,
  };
}

export const renameMedia = (
  data: LibraryData,
  id: string,
  name: string,
): LibraryData =>
  data.media[id]
    ? { ...data, media: { ...data.media, [id]: { ...data.media[id], name } } }
    : data;

/** 删除媒体注册项（需先从各分类/播放列表移除引用后调用） */
export const deleteMediaEntry = (
  data: LibraryData,
  id: string,
): LibraryData => {
  if (!data.media[id]) return data;
  const media = { ...data.media };
  delete media[id];
  return { ...data, media };
};

// ----------------------------- 分类树 -----------------------------

const mapTree = (
  nodes: LibCategory[],
  fn: (node: LibCategory) => LibCategory | null,
): LibCategory[] =>
  nodes
    .map((node) => {
      const hit = fn(node);
      if (hit) return hit;
      const children = mapTree(node.children, fn);
      return children === node.children ? node : { ...node, children };
    })
    .filter(Boolean) as LibCategory[];

export function addCategory(
  data: LibraryData,
  parentId: string | null,
  name: string,
): LibraryData {
  const node: LibCategory = { id: uid(), name, children: [], mediaIds: [] };
  if (parentId == null)
    return { ...data, categories: [...data.categories, node] };
  return {
    ...data,
    categories: mapTree(data.categories, (n) =>
      n.id === parentId ? { ...n, children: [...n.children, node] } : null,
    ),
  };
}

export const renameCategory = (
  data: LibraryData,
  id: string,
  name: string,
): LibraryData => ({
  ...data,
  categories: mapTree(data.categories, (n) =>
    n.id === id ? { ...n, name } : null,
  ),
});

/** 删除分类（含子树），返回新数据与被摘除的媒体 id（供调用方决定是否回收） */
export function removeCategory(
  data: LibraryData,
  id: string,
): { data: LibraryData; removedMediaIds: string[] } {
  const removedIds: string[] = [];
  const collect = (node: LibCategory) => {
    removedIds.push(...node.mediaIds);
    node.children.forEach(collect);
  };
  const target = findCategory(data.categories, id);
  if (target) collect(target);
  const prune = (nodes: LibCategory[]): LibCategory[] =>
    nodes
      .filter((n) => n.id !== id)
      .map((n) =>
        n.children.length ? { ...n, children: prune(n.children) } : n,
      );
  return {
    data: { ...data, categories: prune(data.categories) },
    removedMediaIds: removedIds,
  };
}

export const findCategory = (
  nodes: LibCategory[],
  id: string,
): LibCategory | null => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findCategory(n.children, id);
    if (hit) return hit;
  }
  return null;
};

/** 收藏到指定分类（categoryId 为 null 时进未分类） */
export function favoriteMedia(
  data: LibraryData,
  path: string,
  categoryId: string | null,
): { data: LibraryData; id: string } {
  const { data: withMedia, id } = addMediaEntry(data, path);
  if (categoryId == null) {
    if (withMedia.rootMediaIds.includes(id)) return { data: withMedia, id };
    return {
      data: { ...withMedia, rootMediaIds: [...withMedia.rootMediaIds, id] },
      id,
    };
  }
  return {
    data: {
      ...withMedia,
      categories: mapTree(withMedia.categories, (n) =>
        n.id === categoryId && !n.mediaIds.includes(id)
          ? { ...n, mediaIds: [...n.mediaIds, id] }
          : null,
      ),
    },
    id,
  };
}

export function removeMediaFromCategory(
  data: LibraryData,
  categoryId: string | null,
  mediaId: string,
): LibraryData {
  if (categoryId == null) {
    return {
      ...data,
      rootMediaIds: data.rootMediaIds.filter((m) => m !== mediaId),
    };
  }
  return {
    ...data,
    categories: mapTree(data.categories, (n) =>
      n.id === categoryId
        ? { ...n, mediaIds: n.mediaIds.filter((m) => m !== mediaId) }
        : null,
    ),
  };
}

/** 播放列表引用的媒体 id 全集（回收无引用媒体时排除用） */
export const playlistReferencedIds = (
  playlists: PlaylistData[],
): Set<string> => {
  const set = new Set<string>();
  playlists.forEach((p) => p.mediaIds.forEach((id) => set.add(id)));
  return set;
};

/** 回收既不在分类、也不在任何播放列表中的媒体注册项 */
export function garbageCollectMedia(
  data: LibraryData,
  playlists: PlaylistData[],
): LibraryData {
  const referenced = playlistReferencedIds(playlists);
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
}

// ----------------------------- 播放列表 -----------------------------

export function createPlaylist(
  playlists: PlaylistData[],
  name: string,
): PlaylistData[] {
  return [
    ...playlists,
    { id: uid(), name, mediaIds: [], createdAt: Date.now() },
  ];
}

export const renamePlaylist = (
  playlists: PlaylistData[],
  id: string,
  name: string,
): PlaylistData[] => playlists.map((p) => (p.id === id ? { ...p, name } : p));

export const removePlaylist = (
  playlists: PlaylistData[],
  id: string,
): PlaylistData[] => playlists.filter((p) => p.id !== id);

export const addMediaToPlaylist = (
  playlists: PlaylistData[],
  playlistId: string,
  mediaId: string,
): PlaylistData[] =>
  playlists.map((p) =>
    p.id === playlistId && !p.mediaIds.includes(mediaId)
      ? { ...p, mediaIds: [...p.mediaIds, mediaId] }
      : p,
  );

export const removeMediaFromPlaylist = (
  playlists: PlaylistData[],
  playlistId: string,
  mediaId: string,
): PlaylistData[] =>
  playlists.map((p) =>
    p.id === playlistId
      ? { ...p, mediaIds: p.mediaIds.filter((m) => m !== mediaId) }
      : p,
  );

// ----------------------------- 最近播放 -----------------------------

export function pushRecent(
  list: RecentMedia[],
  item: RecentMedia,
): RecentMedia[] {
  const next = [item, ...list.filter((r) => r.path !== item.path)];
  return next.slice(0, RECENT_MAX);
}

export const removeRecent = (
  list: RecentMedia[],
  path: string,
): RecentMedia[] => list.filter((r) => r.path !== path);

/** 列表展示名：优先元信息名称 */
export const displayName = (
  media: Record<string, LibMedia>,
  id: string,
): string => media[id]?.name || media[id]?.path || '';

/** 按元信息名称排序（localeCompare 支持中文拼音序） */
export const sortIdsByName = (
  media: Record<string, LibMedia>,
  ids: string[],
): string[] =>
  ids
    .map((id) => media[id])
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .map((m) => m.id);
