import React, { useEffect, useRef } from 'react';
import { cn } from 'lib/utils';
import { clamp } from './repeatUtils';
import type { WaveSegment } from './WaveformView';

/**
 * 字幕进度指示条：细长条按时间轴铺出每条字幕的刻度块
 * （琥珀=当前播放、蓝=已勾选、灰=未勾选），播放头实时前移，
 * 点击/拖动可直接定位到任意时间。位于波形条与播放控制栏之间。
 */
export default function SubtitleProgressStrip({
  segments,
  duration,
  getPlayhead,
  onSeek,
  className,
}: {
  segments: WaveSegment[];
  duration: number;
  getPlayhead: () => number;
  onSeek: (sec: number) => void;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({ segments, duration, getPlayhead });
  const dirtyRef = useRef(true);
  if (
    propsRef.current.segments !== segments ||
    propsRef.current.duration !== duration
  ) {
    propsRef.current = { segments, duration, getPlayhead };
    dirtyRef.current = true;
  }
  const scrubRef = useRef(false);

  const lastHeadRef = useRef(-1);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const cv = canvasRef.current;
      const head = propsRef.current.getPlayhead() || 0;
      // 播放头静止且无脏标记时跳过重绘（暂停态零开销）
      if (Math.abs(head - lastHeadRef.current) > 0.001 || dirtyRef.current) {
        dirtyRef.current = false;
        lastHeadRef.current = head;
        if (cv) {
          const {
            segments: segs,
            duration: dur,
            getPlayhead: getHead,
          } = propsRef.current;
          if (dur > 0) {
            const dpr = window.devicePixelRatio || 1;
            const w = cv.clientWidth;
            if (!w) return; // 容器隐藏（display:none）时跳过绘制
            const h = cv.clientHeight || 12;
            if (
              cv.width !== Math.round(w * dpr) ||
              cv.height !== Math.round(h * dpr)
            ) {
              cv.width = Math.round(w * dpr);
              cv.height = Math.round(h * dpr);
            }
            const ctx = cv.getContext('2d');
            if (ctx) {
              ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
              ctx.clearRect(0, 0, w, h);
              for (const seg of segs) {
                const x0 = (seg.start / dur) * w;
                const x1 = (seg.end / dur) * w;
                if (x1 < 0 || x0 > w) continue;
                const vw = Math.max(2, Math.min(w, x1) - Math.max(0, x0));
                ctx.fillStyle = seg.active
                  ? '#ffb02e'
                  : seg.selected
                    ? 'rgba(96,132,252,.9)'
                    : 'rgba(148,163,184,.4)';
                ctx.fillRect(Math.max(0, x0), 2.5, vw, h - 5);
              }
              // 播放头
              const headX = clamp(getHead() / dur, 0, 1) * w;
              ctx.fillStyle = '#eaf2ff';
              ctx.fillRect(headX - 1, 0, 2, h);
            }
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekAt = (clientX: number, rect: DOMRect) => {
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    onSeek(ratio * propsRef.current.duration);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    scrubRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    seekAt(e.clientX, e.currentTarget.getBoundingClientRect());
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!scrubRef.current) return;
    seekAt(e.clientX, e.currentTarget.getBoundingClientRect());
  };

  const endScrub = () => {
    scrubRef.current = false;
  };

  return (
    <canvas
      ref={canvasRef}
      className={cn(
        'block h-3 w-full cursor-pointer touch-none select-none',
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
    />
  );
}
