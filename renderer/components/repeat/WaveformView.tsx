import React, { useEffect, useRef, useCallback } from 'react';
import { cn } from 'lib/utils';
import { clamp, type WavePeaks } from './repeatUtils';

/**
 * 波形视图（移植自 hedaoedu LessonLearnView 的 ocenaudio 式 min/max 包络 Canvas 渲染）：
 * - 小波形（overview）：全时间轴总览，点击定位，滚轮缩放，缩放窗外调暗；
 * - 大波形（zoom）：缩放窗口视图，拖动平移，播放头自动前滚，A/B 旗标可拖动；
 * - 顶部字幕段带：勾选段蓝色、当前播放段琥珀色。
 * 有原始采样时深度放大画逐样本折线（矢量无限清晰），否则按桶状包络绘制。
 */

export interface WaveSegment {
  start: number; // 秒
  end: number; // 秒
  selected: boolean;
  active: boolean;
}

export interface WaveformViewProps {
  variant: 'overview' | 'zoom';
  peaks: WavePeaks | null; // 总览包络（2400 桶）
  finePeaks: WavePeaks | null; // 高精度包络（无原始采样时供大波形用）
  raw: Float32Array | null; // 原始采样（矢量绘制数据源）
  sampleRate: number;
  duration: number; // 媒体总时长（秒）
  playing: boolean;
  getPlayhead: () => number; // 实时播放头（秒），供 rAF 平滑绘制
  abA: number | null;
  abB: number | null;
  abPick: 'A' | 'B' | null; // AB 选点模式：点击画布设点而非定位
  zoom: { a: number; b: number };
  onZoomChange: (z: { a: number; b: number }) => void;
  onOpenZoom: () => void;
  onSeek: (sec: number) => void;
  onABPoint: (sec: number) => void;
  onABDrag: (which: 'A' | 'B', sec: number) => void;
  className?: string;
}

const GREEN = '#4aa96c';
const GREEN_BRIGHT = '#7fdba4';
const AB_COLOR = '#ff9a2e';

export default function WaveformView(props: WaveformViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  // 按需重绘：播放中每帧画（播放头平滑），暂停时仅在 props/尺寸变化后画一帧。
  // 之前 60fps 常驻重绘（每帧数十万次采样扫描）在核显机器上是持续 GPU/CPU 负担。
  const dirtyRef = useRef(true);
  if (propsRef.current !== props) {
    propsRef.current = props;
    dirtyRef.current = true;
  }
  const dragRef = useRef<
    | null
    | { kind: 'A' | 'B'; rect: DOMRect; span: number }
    | {
        kind: 'pan';
        rect: DOMRect;
        startX: number;
        va: number;
        span: number;
        moved: boolean;
      }
  >(null);

  /** 当前画布时间轴总时长：优先波形原始采样换算，回落媒体元数据时长 */
  const waveDurNow = (): number => {
    const { raw, sampleRate, duration } = propsRef.current;
    if (raw && raw.length && sampleRate) return raw.length / sampleRate;
    return duration || 0;
  };

  /** 在 canvas 上绘制 [va,vb] 视图 */
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const p = propsRef.current;
    const raw = p.raw && p.raw.length ? p.raw : null;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    if (!w) return; // 容器隐藏（display:none）时跳过绘制
    const h = cv.clientHeight || 56;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const va = p.variant === 'overview' ? 0 : p.zoom.a;
    const vb = p.variant === 'overview' ? 1 : p.zoom.b;
    const span = vb - va;
    if (span <= 0) return;
    const pd = waveDurNow();
    const mid = h / 2;
    const amp = (h / 2) * 0.92;
    const headT = p.getPlayhead();
    const headR = pd ? clamp(headT / pd, 0, 1) : 0;

    if (raw) {
      // ocenaudio 方式：直接从原始采样绘制（深度放大 = 逐样本折线）
      const total = raw.length;
      const s0 = va * total;
      const s1 = Math.min(vb * total, total);
      const spp = (s1 - s0) / w;
      let visMax = 0.03;
      for (let j = Math.floor(s0); j < Math.min(s1, total); j += 16) {
        const v = Math.abs(raw[j] || 0);
        if (v > visMax) visMax = v;
      }
      const norm = 0.92 / Math.max(0.05, visMax);
      if (spp < 0.5) {
        const i0 = Math.max(0, Math.floor(s0));
        const i1 = Math.min(total, Math.ceil(s1));
        const line = (from: number, to: number, color: string) => {
          ctx.beginPath();
          for (let i = from; i <= to; i++) {
            const x = ((i - s0) / (s1 - s0)) * w;
            const y = mid - (raw[i] || 0) * amp * norm;
            if (i === from) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        };
        const headI = Math.round(headR * total);
        if (headI > i0) line(i0, Math.min(headI, i1), GREEN_BRIGHT);
        if (headI < i1) line(Math.max(headI, i0), i1, GREEN);
      } else {
        const step = Math.max(1, Math.floor(spp / 6));
        for (let x = 0; x < w; x++) {
          const a = Math.floor(s0 + (x / w) * (s1 - s0));
          const b = Math.floor(s0 + ((x + 1) / w) * (s1 - s0));
          let lo = 0;
          let hi = 0;
          for (let j = a; j < b; j += step) {
            const v = raw[j] || 0;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          const tMid = va + ((x + 0.5) / w) * span;
          ctx.fillStyle = tMid <= headR ? GREEN_BRIGHT : GREEN;
          ctx.fillRect(
            x,
            mid - hi * amp * norm,
            1,
            Math.max(1, (hi - lo) * amp * norm),
          );
        }
      }
    } else {
      // 桶状包络（大波形优先用高精度 finePeaks）
      const pk = (p.variant === 'zoom' && p.finePeaks) || p.peaks;
      if (pk) {
        let visMax = 0.03;
        for (let i = 0; i < pk.n; i++) {
          const t = (i + 0.5) / pk.n;
          if (t < va || t > vb) continue;
          const v = Math.max(Math.abs(pk.max[i]), Math.abs(pk.min[i]));
          if (v > visMax) visMax = v;
        }
        const norm = 0.92 / Math.max(0.05, visMax);
        for (let x = 0; x < w; x++) {
          const t0 = va + (x / w) * span;
          const t1 = va + ((x + 1) / w) * span;
          const i0 = Math.floor(t0 * pk.n);
          const i1 = Math.max(i0 + 1, Math.floor(t1 * pk.n));
          let lo = 1;
          let hi = -1;
          for (let i = i0; i < i1 && i < pk.n; i++) {
            if (pk.min[i] < lo) lo = pk.min[i];
            if (pk.max[i] > hi) hi = pk.max[i];
          }
          if (hi < lo) continue;
          const played = t1 <= headR;
          const inZoom =
            !p.variant ||
            p.variant !== 'overview' ||
            (t0 >= p.zoom.a && t1 <= p.zoom.b);
          ctx.fillStyle = played
            ? GREEN_BRIGHT
            : p.variant === 'overview' && !inZoom
              ? '#2c5c46'
              : GREEN;
          const yT = mid - hi * amp * norm;
          const yB = mid - lo * amp * norm;
          ctx.fillRect(x, yT, 1, Math.max(1, yB - yT));
        }
      }
    }
    // 中央线
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(0, mid - 0.5, w, 1);

    // AB 区间高亮 + 竖线
    const abOn = p.abA != null || p.abB != null;
    if (abOn && pd) {
      const xa =
        p.abA != null ? clamp(((p.abA / pd - va) / span) * w, 0, w) : null;
      const xb =
        p.abB != null ? clamp(((p.abB / pd - va) / span) * w, 0, w) : null;
      if (xa != null && xb != null) {
        ctx.fillStyle = 'rgba(255,154,46,.18)';
        ctx.fillRect(Math.min(xa, xb), 0, Math.max(1, Math.abs(xb - xa)), h);
      }
      ctx.fillStyle = AB_COLOR;
      if (xa != null) ctx.fillRect(xa, 0, 1.5, h);
      if (xb != null) ctx.fillRect(xb - 1.5, 0, 1.5, h);
    }

    // 播放头
    if (headR >= va && headR <= vb) {
      const xh = ((headR - va) / span) * w;
      ctx.fillStyle = p.variant === 'zoom' ? '#ff4d4f' : '#eaf2ff';
      ctx.fillRect(xh - 1, 0, 2, h);
    }

    // A/B 旗标（橙块 + 字母）
    if (abOn && pd) {
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      for (const [which, tv] of [
        ['A', p.abA],
        ['B', p.abB],
      ] as const) {
        if (tv == null) continue;
        const x = clamp(((tv / pd - va) / span) * w, 8, w - 8);
        ctx.fillStyle = AB_COLOR;
        ctx.fillRect(x - 8, 10, 16, 13);
        ctx.fillStyle = '#fff';
        ctx.fillText(which, x, 20);
      }
    }

    // 缩放窗外调暗（仅小波形总览）
    if (p.variant === 'overview' && (p.zoom.a > 0 || p.zoom.b < 1)) {
      const xa = p.zoom.a * w;
      const xb = p.zoom.b * w;
      ctx.fillStyle = 'rgba(10,14,20,.52)';
      if (xa > 0) ctx.fillRect(0, 0, xa, h);
      if (xb < w) ctx.fillRect(xb, 0, w - xb, h);
    }
  }, []);

  // 持续重绘：rAF 循环读 propsRef，播放头平滑前移；同时承担大波形自动前滚
  useEffect(() => {
    const cv0 = canvasRef.current;
    if (cv0 && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        dirtyRef.current = true;
      });
      ro.observe(cv0);
      return () => ro.disconnect();
    }
    return undefined;
  }, []);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const p = propsRef.current;
      const cv = canvasRef.current;
      if (cv && p.duration > 0 && (p.playing || dirtyRef.current)) {
        dirtyRef.current = false;
        // 播放头接近窗口右端 8% 时前滚（AB 循环/拖动中不滚）
        if (p.variant === 'zoom' && p.playing && p.abPick == null) {
          // AB 循环中保持窗口不动（框住 AB 区），拖动中也不抢窗口
          const abLooping = p.abA != null && p.abB != null;
          const dragging = dragRef.current != null;
          if (!abLooping && !dragging) {
            const pd = p.duration;
            const z = p.zoom;
            const spanZ = z.b - z.a;
            if (spanZ < 0.999) {
              const headR = clamp(p.getPlayhead() / pd, 0, 1);
              if (headR > z.b - spanZ * 0.08) {
                let a = headR - spanZ * 0.12;
                a = clamp(a, 0, 1 - spanZ);
                p.onZoomChange({ a, b: a + spanZ });
              }
            }
          }
        }
        draw();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  /** 相对位置 → 秒 */
  const posToSec = (
    clientX: number,
    rect: DOMRect,
    va: number,
    span: number,
  ) => {
    const tView = clamp(va + ((clientX - rect.left) / rect.width) * span, 0, 1);
    return { tView, tSec: tView * waveDurNow() };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = propsRef.current;
    if (dragRef.current || p.duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const va = p.variant === 'overview' ? 0 : p.zoom.a;
    const vb = p.variant === 'overview' ? 1 : p.zoom.b;
    const span = vb - va;

    // AB 选点模式：点击设 A/B 点
    if (p.abPick) {
      const { tSec } = posToSec(e.clientX, rect, va, span);
      p.onABPoint(tSec);
      return;
    }

    // A/B 旗标命中 → 进入拖动（鼠标 9px，触摸 22px 命中半径）
    const pd = waveDurNow();
    if (pd && (p.abA != null || p.abB != null)) {
      const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
      const hitR = touch ? 22 : 9;
      for (const which of ['A', 'B'] as const) {
        const tv = which === 'A' ? p.abA : p.abB;
        if (tv == null) continue;
        const x = ((tv / pd - va) / span) * rect.width;
        if (Math.abs(e.clientX - rect.left - x) < hitR) {
          dragRef.current = { kind: which, rect, span };
          e.currentTarget.style.cursor = 'ew-resize';
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* 忽略 */
          }
          return;
        }
      }
    }

    // 大波形：按下进入平移（拖动平移窗口，原地点击定位）；小波形：点击定位
    if (p.variant === 'zoom') {
      dragRef.current = {
        kind: 'pan',
        rect,
        startX: e.clientX,
        va,
        span,
        moved: false,
      };
      e.currentTarget.style.cursor = 'grabbing';
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
    } else {
      const { tView, tSec } = posToSec(e.clientX, rect, va, span);
      p.onSeek(tSec);
      // 点击位置在缩放窗外：平移窗口使点击位置居中
      const z = p.zoom;
      if (span >= 0.999 && (tView < z.a || tView > z.b)) {
        const spanZ = z.b - z.a;
        const a = clamp(tView - spanZ / 2, 0, 1 - spanZ);
        p.onZoomChange({ a, b: a + spanZ });
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = propsRef.current;
    const cv = e.currentTarget;
    const drag = dragRef.current;

    if (drag && drag.kind !== 'pan') {
      // 拖动 A/B 旗标
      const v = p.variant === 'zoom' ? p.zoom : { a: 0, b: 1 };
      const sp = v.b - v.a;
      const { tSec } = posToSec(e.clientX, drag.rect, v.a, sp);
      p.onABDrag(drag.kind, tSec);
      return;
    }
    if (drag && drag.kind === 'pan') {
      if (Math.abs(e.clientX - drag.startX) > 3) drag.moved = true;
      const dx = ((e.clientX - drag.startX) / drag.rect.width) * drag.span;
      const a = clamp(drag.va - dx, 0, 1 - drag.span);
      p.onZoomChange({ a, b: a + drag.span });
      return;
    }

    // 悬停光标：旗标上变左右箭头
    const pd = waveDurNow();
    const rect = cv.getBoundingClientRect();
    const span = p.variant === 'zoom' ? p.zoom.b - p.zoom.a : 1;
    let hit = false;
    if (pd) {
      for (const tv of [p.abA, p.abB]) {
        if (tv == null) continue;
        const x =
          ((tv / pd - (p.variant === 'zoom' ? p.zoom.a : 0)) / span) *
          rect.width;
        if (Math.abs(e.clientX - rect.left - x) < 10) {
          hit = true;
          break;
        }
      }
    }
    cv.style.cursor = hit
      ? 'ew-resize'
      : p.variant === 'zoom'
        ? 'grab'
        : 'pointer';
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = propsRef.current;
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    e.currentTarget.style.cursor = '';
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    if (drag.kind === 'pan' && !drag.moved) {
      const { tSec } = posToSec(e.clientX, drag.rect, drag.va, drag.span);
      p.onSeek(tSec);
    }
  };

  /** 滚轮缩放：以鼠标位置为锚点（原生非 passive 监听才能 preventDefault 阻止页面滚动） */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const handler = (e: WheelEvent) => {
      const p = propsRef.current;
      if (!p.peaks || p.duration <= 0) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      const anchor = clamp((e.clientX - r.left) / r.width, 0, 1);
      const va = p.variant === 'overview' ? 0 : p.zoom.a;
      const vb = p.variant === 'overview' ? 1 : p.zoom.b;
      const span = vb - va;
      const factor = e.deltaY < 0 ? 1 / 1.3 : 1.3;
      const newSpan = clamp(span * factor, 0.015, 1);
      const center = va + anchor * span;
      const a = clamp(center - anchor * newSpan, 0, 1 - newSpan);
      p.onZoomChange({ a, b: a + newSpan });
      if (newSpan < 0.999) p.onOpenZoom();
    };
    cv.addEventListener('wheel', handler, { passive: false });
    return () => cv.removeEventListener('wheel', handler);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={cn(
        'block h-full w-full touch-none select-none',
        props.className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}
