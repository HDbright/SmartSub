import React, { useMemo, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import { Folder, Plus, Star, StarOff, Trash2 } from 'lucide-react';
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
import { useContextMenu, type ContextMenuItemDef } from './RepeatContextMenu';
import { PromptDialog } from './dialogs';
import { GROUP_COLORS, formatShort } from './repeatUtils';
import { uid, type FavoriteCue, type FavoriteGroup } from './mediaLibrary';

export interface FavoriteCuesPanelProps {
  favorites: FavoriteCue[];
  setFavorites: React.Dispatch<React.SetStateAction<FavoriteCue[]>>;
  favGroups: FavoriteGroup[];
  setFavGroups: React.Dispatch<React.SetStateAction<FavoriteGroup[]>>;
  /** 当前播放定位键（sourceSubtitle@start）用于高亮 */
  currentKey?: string | null;
  /** 点击收藏句：定位到对应视频的字幕句段 */
  onLocate: (fav: FavoriteCue) => void;
  /** 分组筛选（由工作台持有，新收藏自动归入该分组） */
  groupFilter: string;
  onGroupFilterChange: (v: string) => void;
}

/** 收藏的字幕句：分组管理、出处信息（字幕文件 + 时间戳）、点击定位回播 */
export default function FavoriteCuesPanel({
  favorites,
  setFavorites,
  favGroups,
  setFavGroups,
  currentKey,
  onLocate,
  groupFilter,
  onGroupFilterChange,
}: FavoriteCuesPanelProps) {
  const { t } = useTranslation('repeat');
  const { openMenu, menuElement } = useContextMenu();
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  const groupColor = (groupId: string | null): string | null => {
    if (!groupId) return null;
    const idx = favGroups.findIndex((g) => g.id === groupId);
    return idx >= 0 ? GROUP_COLORS[idx % GROUP_COLORS.length] : null;
  };

  const filtered = useMemo(() => {
    if (groupFilter === 'all') return favorites;
    if (groupFilter === 'none') return favorites.filter((f) => !f.groupId);
    return favorites.filter((f) => f.groupId === groupFilter);
  }, [favorites, groupFilter]);

  const createGroup = (name: string) => {
    setFavGroups((prev) => [
      ...prev,
      {
        id: uid(),
        name,
        color: GROUP_COLORS[prev.length % GROUP_COLORS.length],
      },
    ]);
  };

  const deleteActiveGroup = () => {
    if (groupFilter === 'all' || groupFilter === 'none') return;
    const groupId = groupFilter;
    setFavGroups((prev) => prev.filter((g) => g.id !== groupId));
    setFavorites((prev) =>
      prev.map((f) => (f.groupId === groupId ? { ...f, groupId: null } : f)),
    );
    onGroupFilterChange('all');
    toast.success(t('fav.groupDeleted'));
  };

  const assignToGroup = (
    fav: FavoriteCue,
    groupId: string | null,
    label: string,
  ) => {
    setFavorites((prev) =>
      prev.map((f) => (f.id === fav.id ? { ...f, groupId } : f)),
    );
    if (groupId) toast.success(t('fav.assigned', { label }));
  };

  const menuFor = (fav: FavoriteCue) => {
    const items: ContextMenuItemDef[] = [
      {
        key: 'locate',
        label: t('fav.locate'),
        icon: Star,
        onSelect: () => onLocate(fav),
      },
    ];
    favGroups.forEach((g) => {
      items.push({
        key: `g-${g.id}`,
        label: t('fav.moveToGroup', { label: g.name }),
        icon: Folder,
        onSelect: () => assignToGroup(fav, g.id, g.name),
      });
    });
    if (fav.groupId) {
      items.push({
        key: 'ungroup',
        label: t('fav.removeGroup'),
        icon: StarOff,
        danger: true,
        onSelect: () => assignToGroup(fav, null, ''),
      });
    }
    items.push({
      key: 'delete',
      label: t('fav.delete'),
      icon: Trash2,
      danger: true,
      onSelect: () =>
        setFavorites((prev) => prev.filter((f) => f.id !== fav.id)),
    });
    return items;
  };

  if (!favorites.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Button
          variant="ghost"
          size="sm"
          className="mb-1 h-6 self-start gap-1 px-1.5 text-[11px]"
          onClick={() => setNewGroupOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('fav.newGroup')}
        </Button>
        <EmptyState
          icon={Star}
          title={t('fav.empty')}
          description={t('fav.emptyDesc')}
          className="flex-1 justify-center"
        />
        <PromptDialog
          open={newGroupOpen}
          title={t('fav.newGroup')}
          onSubmit={createGroup}
          onClose={() => setNewGroupOpen(false)}
        />
        {menuElement}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={() => setNewGroupOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('fav.newGroup')}
        </Button>
        <Select value={groupFilter} onValueChange={onGroupFilterChange}>
          <SelectTrigger
            className="h-6 w-[120px] text-[11px]"
            aria-label={t('fav.filter')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('fav.all')}</SelectItem>
            <SelectItem value="none">{t('fav.unGrouped')}</SelectItem>
            {favGroups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {groupFilter !== 'all' && groupFilter !== 'none' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px] text-destructive hover:text-destructive"
            onClick={deleteActiveGroup}
          >
            <Trash2 className="h-3 w-3" />
            {t('fav.removeGroup')}
          </Button>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground tnum">
          {t('fav.count', { n: filtered.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {filtered.map((fav) => {
          const color = groupColor(fav.groupId);
          const subName = fav.sourceSubtitle.slice(
            Math.max(
              fav.sourceSubtitle.lastIndexOf('\\'),
              fav.sourceSubtitle.lastIndexOf('/'),
            ) + 1,
          );
          const key = `${fav.sourceSubtitle}@${fav.start.toFixed(2)}`;
          return (
            <div
              key={fav.id}
              onClick={() => onLocate(fav)}
              onContextMenu={(e) => openMenu(e, menuFor(fav))}
              className={cn(
                'flex cursor-pointer gap-2 rounded-md border px-2 py-1.5 transition-colors',
                currentKey === key
                  ? 'border-primary/60 bg-primary/10'
                  : 'border-transparent hover:border-border hover:bg-accent/50',
              )}
              title={t('fav.locateHint')}
            >
              <span
                className="mt-0.5 flex h-4 w-[3px] flex-shrink-0 rounded-full"
                style={{ backgroundColor: color || 'rgba(148,163,184,.4)' }}
                title={
                  favGroups.find((g) => g.id === fav.groupId)?.name ||
                  t('fav.unGrouped')
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block whitespace-pre-wrap break-words text-[12.5px] leading-snug text-foreground/90">
                  {fav.text}
                </span>
                <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
                  {t('fav.from')} {subName} · {formatShort(fav.start)} -{' '}
                  {formatShort(fav.end)}
                </span>
              </span>
            </div>
          );
        })}
        {!filtered.length && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t('fav.filterEmpty')}
          </p>
        )}
      </div>

      {menuElement}
      <PromptDialog
        open={newGroupOpen}
        title={t('fav.newGroup')}
        onSubmit={createGroup}
        onClose={() => setNewGroupOpen(false)}
      />
    </div>
  );
}
