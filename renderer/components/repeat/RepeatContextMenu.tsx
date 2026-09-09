import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from 'lib/utils';

/**
 * 复读页轻量右键菜单：fixed 定位 + 边缘防溢出，点击项/外部/Esc 关闭。
 * 项目未引入 radix context-menu，媒体库/播放列表/最近播放的右键操作统一走这里。
 */

export interface ContextMenuItemDef {
  key: string;
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  onSelect: () => void;
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItemDef[];
  } | null>(null);

  const openMenu = (e: React.MouseEvent, items: ContextMenuItemDef[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const closeMenu = () => setMenu(null);

  const menuElement = menu ? (
    <FloatingMenu
      x={menu.x}
      y={menu.y}
      items={menu.items}
      onClose={closeMenu}
    />
  ) : null;

  return { openMenu, closeMenu, menuElement };
}

function FloatingMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItemDef[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[100] min-w-[140px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent',
              item.danger ? 'text-destructive hover:text-destructive' : '',
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5 flex-shrink-0" /> : null}
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
