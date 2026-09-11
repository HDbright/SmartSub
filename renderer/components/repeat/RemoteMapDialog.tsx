/**
 * 手柄/遥控按键映射浮动面板（键盘 + 蓝牙 BLE 手柄两部分）。
 *
 * 自绘可拖拽面板（非 Radix Dialog）：无遮罩、不锁页面滚动，复读页面保持清晰
 * 可交互，方便对照画面/列表设置映射；标题栏按住拖动移动位置。
 *
 * 键盘部分：蓝牙 HID 类手柄或键盘按键 → useHotkeys 组合格式（repeatPlaybackCfg.remoteMap）。
 * BLE 部分：私有协议蓝牙复读手柄（如艺漫新 BHA02）经主进程 bleRemote 桥直连，
 * 按键为 1 字节键码（按下 0x20..，松开 0x00）→ repeatPlaybackCfg.bleMap。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Bluetooth,
  BluetoothConnected,
  BluetoothOff,
  Play,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from 'lib/utils';

export interface RemoteActionDef {
  id: string;
  label: string;
  /** 动作执行体（对话框自身不调用，由 RepeatWorkbench 执行） */
  run?: () => void;
}

/** 已登记的蓝牙遥控设备（与 RepeatWorkbench 的 RemoteDeviceDef 结构一致） */
export interface RemoteDeviceEntry {
  id: string;
  label: string;
  nameFilter: string;
  charFragment: string;
  addedAt: number;
  lastConnectedAt?: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  actions: RemoteActionDef[];
  /** 键盘组合键 → 动作 id */
  map: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** BLE 桥状态：off / scanning / connected / disconnected */
  bleStatus: string;
  onBleToggle: () => void;
  /** BLE 键码（'21'）→ 动作 id */
  bleMap: Record<string, string>;
  onBleMapChange: (next: Record<string, string>) => void;
  /** 蓝牙遥控设备记录 */
  devices: RemoteDeviceEntry[];
  activeDeviceId: string;
  onUseDevice: (d: RemoteDeviceEntry) => void;
  onAddDevice: (
    label: string,
    nameFilter: string,
    charFragment: string,
  ) => RemoteDeviceEntry;
  onDeleteDevice: (id: string) => void;
  /** 播放最近一次播放的媒体 */
  onPlayLast?: () => void;
  canPlayLast?: boolean;
}

const isModifierKey = (e: KeyboardEvent) =>
  ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key);

/** 把按键事件转成 useHotkeys 组合键字符串；纯修饰键返回 null（忽略） */
function comboFromEvent(e: KeyboardEvent): string | null {
  if (isModifierKey(e)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

interface BleEvent {
  type: string;
  value: string;
}

export default function RemoteMapDialog({
  open,
  onClose,
  actions,
  map,
  onChange,
  bleStatus,
  onBleToggle,
  bleMap,
  onBleMapChange,
  devices,
  activeDeviceId,
  onUseDevice,
  onAddDevice,
  onDeleteDevice,
  onPlayLast,
  canPlayLast,
}: Props) {
  const { t } = useTranslation('repeat');
  const [capturing, setCapturing] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<{
    key: string;
    code: string;
    keyCode: number;
  } | null>(null);
  const [capturingBle, setCapturingBle] = useState<string | null>(null);
  const [lastBleCode, setLastBleCode] = useState<string | null>(null);
  const [newDevLabel, setNewDevLabel] = useState('');
  const [newDevFilter, setNewDevFilter] = useState('');
  const [newDevChar, setNewDevChar] = useState('fb01');
  // 捕获目标用 ref 供 IPC 回调读取最新值
  const capturingBleRef = useRef<string | null>(null);
  capturingBleRef.current = capturingBle;

  // ---- 浮动面板拖拽（标题栏按住拖动）----
  const [pos, setPos] = useState(() => ({
    x: Math.max(
      16,
      (typeof window !== 'undefined' ? window.innerWidth : 1200) - 560,
    ),
    y: 56,
  }));
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      x: Math.min(
        Math.max(e.clientX - d.dx, 8),
        Math.max(8, window.innerWidth - 160),
      ),
      y: Math.min(Math.max(e.clientY - d.dy, 8), window.innerHeight - 60),
    });
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };

  // Esc 关闭面板（捕获进行中的按键由各自监听优先拦截）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !capturing && !capturingBle) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, capturing, capturingBle, onClose]);

  // 监视：仅记录最后按下的键（用于确认手柄/键盘按键的实际键码）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      setLastKey({ key: e.key, code: e.code, keyCode: e.keyCode });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 键盘绑定：捕获阶段拦截下一次按键，避免触发动机本身
  useEffect(() => {
    if (!open || !capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const next = { ...map };
      Object.keys(next).forEach((k) => {
        if (k !== combo && next[k] === capturing) delete next[k];
      });
      next[combo] = capturing;
      onChange(next);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, capturing, map, onChange]);

  // BLE：监听桥事件（最近键码 + 捕获绑定）
  useEffect(() => {
    if (!open) return;
    const off = window?.ipc?.on?.('bleRemote:event', (payload: BleEvent) => {
      if (!payload || payload.type !== 'code') return;
      const code = payload.value;
      if (!code || code === '00') return; // 松开帧
      setLastBleCode(code);
      const actionId = capturingBleRef.current;
      if (!actionId) return;
      const next = { ...bleMap };
      Object.keys(next).forEach((k) => {
        if (k !== code && next[k] === actionId) delete next[k];
      });
      next[code] = actionId;
      onBleMapChange(next);
      setCapturingBle(null);
    });
    return () => off?.();
    // bleMap/onBleMapChange 变化会重挂监听，闭包保持新鲜
  }, [open, bleMap, onBleMapChange]);

  if (!open) return null;

  const keyOf = (actionId: string) =>
    Object.keys(map).find((k) => map[k] === actionId);
  const bleCodeOf = (actionId: string) =>
    Object.keys(bleMap).find((k) => bleMap[k] === actionId);

  const clearBinding = (actionId: string) => {
    const next = { ...map };
    Object.keys(next).forEach((k) => {
      if (next[k] === actionId) delete next[k];
    });
    onChange(next);
  };
  const clearBleBinding = (actionId: string) => {
    const next = { ...bleMap };
    Object.keys(next).forEach((k) => {
      if (next[k] === actionId) delete next[k];
    });
    onBleMapChange(next);
  };

  const bleConnected = bleStatus === 'connected';
  const bleRunning = bleStatus !== 'off';

  return (
    <div
      className="fixed z-[70] w-[560px] max-w-[94vw] rounded-lg border border-border bg-popover shadow-xl"
      style={{ left: pos.x, top: pos.y }}
    >
      {/* 标题栏：按住拖动 */}
      <div
        className="flex cursor-move touch-none items-center justify-between rounded-t-lg border-b border-border px-3 py-1.5"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <span className="text-xs font-medium">{t('remote.title')}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 内容区：内部滚动，不遮挡页面 */}
      <div className="max-h-[calc(100vh-140px)] space-y-1.5 overflow-y-auto p-2.5">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t('remote.pairHint')}
        </p>

        {/* 蓝牙遥控设备管理区 */}
        <div className="space-y-1.5 rounded-md border border-border p-2">
          <div className="flex items-center gap-2">
            {bleConnected ? (
              <BluetoothConnected className="h-4 w-4 text-blue-500" />
            ) : bleRunning ? (
              <Bluetooth className="h-4 w-4 animate-pulse text-amber-500" />
            ) : (
              <BluetoothOff className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-xs font-medium">{t('remote.bleTitle')}</span>
            <span
              className={cn(
                'text-[11px]',
                bleConnected
                  ? 'text-blue-500'
                  : bleRunning
                    ? 'text-amber-500'
                    : 'text-muted-foreground',
              )}
            >
              {bleConnected
                ? t('remote.bleConnected')
                : bleRunning
                  ? t('remote.bleRetrying')
                  : t('remote.bleOff')}
            </span>
            <span className="flex-1" />
            {onPlayLast && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
                disabled={!canPlayLast}
                title={t('remote.playLastTitle')}
                onClick={onPlayLast}
              >
                <Play className="h-3 w-3" />
                {t('remote.playLast')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={onBleToggle}
            >
              {bleRunning
                ? t('remote.bleToggleStop')
                : t('remote.bleToggleStart')}
            </Button>
          </div>

          {/* 设备记录列表 */}
          <div className="space-y-0.5">
            {devices.map((d) => {
              const active = d.id === activeDeviceId;
              return (
                <div
                  key={d.id}
                  className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-accent/50"
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 flex-shrink-0 rounded-full',
                      active
                        ? bleConnected
                          ? 'bg-emerald-500'
                          : 'bg-amber-500'
                        : 'bg-muted-foreground/40',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {d.label}
                    <span className="ml-1 text-muted-foreground">
                      ({d.nameFilter}
                      {d.charFragment && d.charFragment !== 'fb01'
                        ? ` · ${d.charFragment}`
                        : ''}
                      {d.lastConnectedAt
                        ? ` · ${t('remote.deviceLast')} ${new Date(
                            d.lastConnectedAt,
                          ).toLocaleString()}`
                        : ''}
                      )
                    </span>
                  </span>
                  {active ? (
                    <span className="flex-shrink-0 text-primary">
                      {t('remote.deviceActive')}
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-5 flex-shrink-0 px-1.5 text-[10.5px]"
                      onClick={() => onUseDevice(d)}
                    >
                      {t('remote.deviceUse')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 flex-shrink-0 px-1 text-[10.5px] text-muted-foreground"
                    onClick={() => onDeleteDevice(d.id)}
                  >
                    {t('remote.deviceDelete')}
                  </Button>
                </div>
              );
            })}
          </div>

          {/* 添加设备 */}
          <div className="flex flex-wrap items-center gap-1 border-t border-border pt-1.5">
            <Input
              className="h-6 w-28 min-w-0 flex-1 text-[11px]"
              placeholder={t('remote.deviceLabel')}
              value={newDevLabel}
              onChange={(e) => setNewDevLabel(e.target.value)}
            />
            <Input
              className="h-6 w-24 min-w-0 text-[11px]"
              placeholder={t('remote.deviceFilter')}
              value={newDevFilter}
              onChange={(e) => setNewDevFilter(e.target.value)}
            />
            <Input
              className="h-6 w-20 min-w-0 font-mono text-[11px]"
              placeholder="fb01"
              title={t('remote.deviceChar')}
              value={newDevChar}
              onChange={(e) => setNewDevChar(e.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-6 flex-shrink-0 px-2 text-[11px]"
              disabled={!newDevLabel.trim() || !newDevFilter.trim()}
              onClick={() => {
                const dev = onAddDevice(
                  newDevLabel.trim(),
                  newDevFilter.trim(),
                  newDevChar.trim(),
                );
                setNewDevLabel('');
                setNewDevFilter('');
                setNewDevChar('fb01');
                onUseDevice(dev);
              }}
            >
              {t('remote.deviceAdd')}
            </Button>
          </div>
          <p className="text-[10.5px] leading-relaxed text-muted-foreground">
            {t('remote.bleHint')}
          </p>
          <div className="rounded bg-muted/40 px-2 py-1 font-mono text-[11px]">
            <span className="text-muted-foreground">{t('remote.bleLast')}</span>
            {lastBleCode ? ` 0x${lastBleCode}` : ' —'}
            {lastKey ? (
              <span className="text-muted-foreground">
                {'  |  '}
                {t('remote.lastKey')}
                {` key=${lastKey.key} code=${lastKey.code}`}
              </span>
            ) : null}
          </div>
        </div>

        {/* 动作映射列表 */}
        <div className="space-y-0.5">
          {actions.map((a) => {
            const bound = keyOf(a.id);
            const bleBound = bleCodeOf(a.id);
            const isCapturing = capturing === a.id;
            const isCapturingBle = capturingBle === a.id;
            return (
              <div
                key={a.id}
                className="flex flex-wrap items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-accent/50"
              >
                <span className="min-w-0 flex-1 truncate" title={a.label}>
                  {a.label}
                </span>
                {/* 键盘绑定 */}
                {isCapturing ? (
                  <span className="animate-pulse text-[11px] text-primary">
                    {t('remote.pressPrompt')}
                  </span>
                ) : (
                  <span
                    className={cn(
                      'min-w-[86px] truncate rounded border border-border px-1.5 py-0.5 text-center text-[11px]',
                      bound ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {bound || t('remote.unbound')}
                  </span>
                )}
                {!isCapturing && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 flex-shrink-0 px-1.5 text-[11px]"
                    onClick={() => setCapturing(a.id)}
                  >
                    {t('remote.bind')}
                  </Button>
                )}
                {!isCapturing && bound && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 flex-shrink-0 px-1 text-[11px]"
                    onClick={() => clearBinding(a.id)}
                  >
                    {t('remote.clear')}
                  </Button>
                )}
                {/* BLE 手柄绑定 */}
                {isCapturingBle ? (
                  <span className="animate-pulse text-[11px] text-primary">
                    {t('remote.blePressPrompt')}
                  </span>
                ) : (
                  <span
                    className={cn(
                      'min-w-[52px] truncate rounded border border-border px-1.5 py-0.5 text-center font-mono text-[11px]',
                      bleBound
                        ? 'border-primary/50 bg-primary/5 text-primary'
                        : 'text-muted-foreground',
                    )}
                  >
                    {bleBound ? `0x${bleBound}` : t('remote.unbound')}
                  </span>
                )}
                {!isCapturingBle && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 flex-shrink-0 px-1.5 text-[11px]"
                    onClick={() => setCapturingBle(a.id)}
                  >
                    {t('remote.bleBind')}
                  </Button>
                )}
                {!isCapturingBle && bleBound && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 flex-shrink-0 px-1 text-[11px]"
                    onClick={() => clearBleBinding(a.id)}
                  >
                    {t('remote.clear')}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
