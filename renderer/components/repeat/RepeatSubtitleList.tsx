import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Check, Pencil, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from 'lib/utils';
import {
  formatShort,
  parseClockInput,
  type GroupAssignment,
  type RepeatCue,
} from './repeatUtils';

/**
 * 复读字幕列表：
 * - 勾选复选框 / 按住拖动框选多段 → 选中片段参与「播放所选」循环或按遍数复读；
 * - 单击行定位播放；双击文本或点铅笔进入行内编辑（文本 + 起止时间）；
 * - 播放时当前字幕高亮并自动滚动。
 */

export interface RepeatSubtitleListProps {
  cues: RepeatCue[];
  activeIndex: number; // 当前播放位置命中的字幕
  queueIndex: number; // 复读队列当前段（-1 表示未在复读）
  selection: Set<number>;
  onSelectionChange: (next: Set<number>, source?: 'checkbox' | 'bulk') => void;
  onActivate: (index: number) => void;
  onEdit: (
    index: number,
    patch: { start?: number; end?: number; text?: string },
  ) => void;
  /** 分组标记（cue.id -> 组） */
  groups?: GroupAssignment;
  /** 行右键菜单（归入分组 / 收藏等） */
  onRowContextMenu?: (e: React.MouseEvent, index: number) => void;
  /** 搜索词：命中文字在行内高亮 */
  searchQuery?: string;
  /** 当前定位的搜索命中（该行加定位光圈并滚动到可见） */
  activeMatchId?: string | null;
  /** 单句重复开启时，正在循环播放的行用橙色边框 */
  singleRepeatActive?: boolean;
  className?: string;
}

export default function RepeatSubtitleList({
  cues,
  activeIndex,
  queueIndex,
  selection,
  onSelectionChange,
  onActivate,
  onEdit,
  onRowContextMenu,
  groups,
  searchQuery = '',
  activeMatchId = null,
  singleRepeatActive = false,
  className,
}: RepeatSubtitleListProps) {
  const { t } = useTranslation('repeat');
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [editingIndex, setEditingIndex] = useState(-1);
  const [draft, setDraft] = useState({ text: '', start: '', end: '' });
  // 拖拽框选状态
  const dragRef = useRef<{
    anchor: number;
    moved: boolean;
    base: Set<number>; // 按下时的选中集（拖动回退用）
  } | null>(null);
  const lastClickedRef = useRef(-1);

  // 当前字幕变化时自动滚动到可见区
  useEffect(() => {
    if (activeIndex < 0) return;
    rowRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // 搜索定位：当前命中的行滚动到可见区
  useEffect(() => {
    if (!activeMatchId) return;
    const i = cues.findIndex((c) => c.id === activeMatchId);
    if (i >= 0) rowRefs.current[i]?.scrollIntoView({ block: 'center' });
  }, [activeMatchId, cues]);

  /** 搜索命中文字高亮（忽略大小写） */
  const renderHighlighted = (text: string) => {
    const q = searchQuery.trim();
    if (!q) return text;
    const lower = text.toLowerCase();
    const ql = q.toLowerCase();
    const nodes: React.ReactNode[] = [];
    let from = 0;
    let idx = lower.indexOf(ql);
    let key = 0;
    while (idx !== -1) {
      if (idx > from) nodes.push(text.slice(from, idx));
      nodes.push(
        <mark
          key={`m${key++}`}
          className="rounded-sm bg-amber-300/90 px-0.5 text-black"
        >
          {text.slice(idx, idx + ql.length)}
        </mark>,
      );
      from = idx + ql.length;
      idx = lower.indexOf(ql, from);
    }
    nodes.push(text.slice(from));
    return nodes;
  };

  const toggleOne = (i: number) => {
    const next = new Set(selection);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    onSelectionChange(next, 'checkbox');
  };

  const selectRange = (a: number, b: number, base?: Set<number>) => {
    const next = base ? new Set(base) : new Set<number>();
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) next.add(i);
    onSelectionChange(next, 'bulk');
  };

  /** 行按下：记录锚点，等待拖动或点击 */
  const handleRowPointerDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0 || editingIndex >= 0) return;
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    dragRef.current = { anchor: i, moved: false, base: new Set(selection) };
    // 指针在列表外释放时兜底清理（容器 onPointerUp 只覆盖列表内部）
    window.addEventListener('pointerup', finishDrag, { once: true });
  };

  /** 行上进入：按住拖动时框选 [锚点..当前] */
  const handleRowPointerEnter = (e: React.PointerEvent, i: number) => {
    const drag = dragRef.current;
    if (!drag || drag.anchor === i) return;
    drag.moved = true;
    // 普通拖动 = 重新框选；Ctrl/Shift 拖动 = 在原选中基础上追加
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    selectRange(drag.anchor, i, additive ? drag.base : undefined);
  };

  const suppressClickRef = useRef(false);

  /** 结束框选：若发生过拖动，抑制随后的 click（click 总在 pointerup 之后触发） */
  const finishDrag = () => {
    const drag = dragRef.current;
    if (drag && drag.moved) suppressClickRef.current = true;
    dragRef.current = null;
  };

  const handleRowClick = (e: React.MouseEvent, i: number) => {
    if (editingIndex >= 0) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    // Ctrl/Cmd + 点击 = 勾选切换；Shift + 点击 = 从上次点击处范围勾选
    if (e.ctrlKey || e.metaKey) {
      toggleOne(i);
      lastClickedRef.current = i;
      return;
    }
    if (e.shiftKey && lastClickedRef.current >= 0) {
      selectRange(lastClickedRef.current, i);
      return;
    }
    lastClickedRef.current = i;
    onActivate(i);
  };

  const startEdit = (i: number) => {
    const cue = cues[i];
    if (!cue) return;
    setEditingIndex(i);
    setDraft({
      text: cue.text,
      start: formatShort(cue.start),
      end: formatShort(cue.end),
    });
  };

  const commitEdit = () => {
    if (editingIndex < 0) return;
    const start = parseClockInput(draft.start);
    const end = parseClockInput(draft.end);
    onEdit(editingIndex, {
      text: draft.text.replace(/\r\n/g, '\n'),
      ...(start != null ? { start } : {}),
      ...(end != null ? { end } : {}),
    });
    setEditingIndex(-1);
  };

  if (!cues.length) return null;

  return (
    <div
      className={cn('flex select-none flex-col gap-1', className)}
      onPointerUp={finishDrag}
      onPointerLeave={finishDrag}
    >
      {cues.map((cue, i) => {
        const group = groups?.[cue.id];
        const selected = selection.has(i);
        const active = i === activeIndex;
        const inQueue = i === queueIndex;
        const editing = i === editingIndex;
        return (
          <div
            key={cue.id || i}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            data-cue-index={i}
            onPointerDown={(e) => handleRowPointerDown(e, i)}
            onPointerEnter={(e) => handleRowPointerEnter(e, i)}
            onClick={(e) => handleRowClick(e, i)}
            onDoubleClick={() => startEdit(i)}
            onContextMenu={(e) => onRowContextMenu?.(e, i)}
            className={cn(
              'group relative flex cursor-pointer gap-2 rounded-md border px-2 py-1.5 transition-colors',
              active
                ? singleRepeatActive
                  ? 'border-amber-500 bg-amber-500/10'
                  : 'border-primary/60 bg-primary/10'
                : inQueue
                  ? 'border-amber-500/60 bg-amber-500/10'
                  : selected
                    ? 'border-primary/30 bg-muted/60'
                    : 'border-transparent hover:border-border hover:bg-accent/50',
              i === activeIndex && singleRepeatActive && '-left-px',
              cue.id === activeMatchId && 'ring-2 ring-amber-400/80',
            )}
          >
            {active && (
              <span
                className={cn(
                  'absolute -left-px inset-y-1 w-[3px] rounded-full',
                  singleRepeatActive ? 'bg-amber-500' : 'bg-primary',
                )}
              />
            )}
            {group && (
              <span
                className="w-[3px] flex-shrink-0 self-stretch rounded-full"
                style={{ backgroundColor: group.color }}
                title={group.label}
              />
            )}
            <span
              data-no-drag
              className="pt-0.5"
              onClick={(e) => e.stopPropagation()}
            >
              <Checkbox
                checked={selected}
                onCheckedChange={() => toggleOne(i)}
                aria-label={t('list.selectOne', { index: i + 1 })}
              />
            </span>
            {group && (
              <span
                className="mt-0.5 flex h-4 min-w-[16px] flex-shrink-0 items-center justify-center rounded px-1 text-[9px] font-semibold leading-none text-white"
                style={{ backgroundColor: group.color }}
                title={group.label}
              >
                {group.index}
              </span>
            )}
            <span className="w-[96px] flex-shrink-0 pt-0.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground tnum">
              <span className="block">{formatShort(cue.start)}</span>
              <span className="block">{formatShort(cue.end)}</span>
            </span>
            {editing ? (
              <div
                className="flex-1 min-w-0 space-y-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <Textarea
                  autoFocus
                  rows={2}
                  className="min-h-0 text-[12.5px]"
                  value={draft.text}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, text: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      commitEdit();
                    } else if (e.key === 'Escape') {
                      setEditingIndex(-1);
                    }
                  }}
                />
                <div className="flex items-center gap-1.5">
                  <span className="text-[10.5px] text-muted-foreground">
                    {t('list.start')}
                  </span>
                  <Input
                    className="h-6 w-[86px] font-mono text-[11px]"
                    value={draft.start}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, start: e.target.value }))
                    }
                  />
                  <span className="text-[10.5px] text-muted-foreground">
                    {t('list.end')}
                  </span>
                  <Input
                    className="h-6 w-[86px] font-mono text-[11px]"
                    value={draft.end}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, end: e.target.value }))
                    }
                  />
                  <Button
                    size="sm"
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={commitEdit}
                  >
                    <Check className="h-3 w-3" />
                    {t('list.save')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setEditingIndex(-1)}
                  >
                    <X className="h-3 w-3" />
                    {t('list.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <span
                  className={cn(
                    'flex-1 min-w-0 whitespace-pre-wrap break-words text-[12.5px] leading-snug',
                    active ? 'text-foreground' : 'text-foreground/90',
                  )}
                >
                  {cue.text ? (
                    renderHighlighted(cue.text)
                  ) : (
                    <span className="italic text-muted-foreground">
                      {t('list.emptyText')}
                    </span>
                  )}
                </span>
                <span
                  data-no-drag
                  className="self-start opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    aria-label={t('list.edit')}
                    onClick={() => startEdit(i)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </span>
                <span className="w-6 flex-shrink-0 self-start text-right font-mono text-[10.5px] text-faint tnum">
                  {i + 1}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
