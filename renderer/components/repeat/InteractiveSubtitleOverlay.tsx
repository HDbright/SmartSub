/**
 * 可交互字幕叠加层：仅在「字幕样式设置」窗口打开时渲染（替代只读的 SubtitlePreviewOverlay）。
 * - 鼠标拖拽字幕本体 → 调整垂直位置（联动 marginV，并按需归一化对齐方式）；
 * - 悬停显示虚线边框，拖拽右下角手柄 → 调整字号（联动 fontSize）。
 * 所有改动通过 onUpdateStyle 回写 subtitleStyle 状态，与样式窗口中的数值实时联动。
 */

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type {
  SubtitleAlignment,
  SubtitleStyle,
} from '../../../types/subtitleMerge';
import {
  subtitleStyleToCSS,
  getSubtitleContainerStyle,
} from '@/components/subtitleMerge/utils/styleUtils';
import { FONT_SIZE_RANGE } from '@/components/subtitleMerge/constants';

interface InteractiveSubtitleOverlayProps {
  style: SubtitleStyle;
  text: string;
  scale: number;
  onUpdateStyle: (updates: Partial<SubtitleStyle>) => void;
}

interface DragState {
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  // move
  startMarginV: number;
  startRow: 0 | 2; // 归一化后的行：0=底部、2=顶部（中间对齐归一化为底部）
  startColumn: number; // 0/1/2 = 左/中/右
  maxV: number;
  // resize
  startFontSize: number;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export default function InteractiveSubtitleOverlay({
  style,
  text,
  scale,
  onUpdateStyle,
}: InteractiveSubtitleOverlayProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [frame, setFrame] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [resizing, setResizing] = useState(false);

  const s = scale > 0 ? scale : 1;

  const measure = useCallback(() => {
    const box = boxRef.current;
    const span = textRef.current;
    if (!box || !span) return;
    const br = box.getBoundingClientRect();
    const sr = span.getBoundingClientRect();
    setFrame({
      x: sr.left - br.left,
      y: sr.top - br.top,
      w: sr.width,
      h: sr.height,
    });
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (boxRef.current) ro.observe(boxRef.current);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, text, style.fontSize, style.marginV, style.alignment]);

  const startMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = boxRef.current;
    const span = textRef.current;
    const boxH = box?.clientHeight ?? 0;
    const textH = span?.offsetHeight ?? 0;

    let row: 0 | 2 = Math.floor((style.alignment - 1) / 3) === 2 ? 2 : 0;
    let baseMarginV = style.marginV;
    // 中间对齐（row 1）没有「边距」语义，归一化为底部对齐：等效边距=文字中心距底部。
    if (Math.floor((style.alignment - 1) / 3) === 1) {
      row = 0;
      baseMarginV = boxH > 0 ? (boxH - textH) / 2 / s : style.marginV;
    }

    dragRef.current = {
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      startMarginV: baseMarginV,
      startRow: row,
      startColumn: (style.alignment - 1) % 3,
      maxV: Math.max(240, Math.round(boxH / s)),
      startFontSize: style.fontSize,
    };
    setHovered(true);
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      startMarginV: style.marginV,
      startRow: 0,
      startColumn: (style.alignment - 1) % 3,
      maxV: 240,
      startFontSize: style.fontSize,
    };
    setHovered(true);
    setResizing(true);
  };

  const handleMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === 'move') {
      const dy = (e.clientY - d.startY) / s;
      // 底部对齐：上拖增大边距；顶部对齐：下拖增大边距
      const sign = d.startRow === 0 ? -1 : 1;
      const marginV = clamp(d.startMarginV + sign * dy, 0, d.maxV);
      const alignment = ((d.startRow === 0 ? 1 : 7) +
        d.startColumn) as SubtitleAlignment;
      onUpdateStyle({ marginV: Math.round(marginV), alignment });
    } else {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      // 右下角手柄：向右下拖放大、向左上拖缩小（斜向综合分量）
      const delta = (dx + dy) / 2 / s;
      const fontSize = clamp(
        Math.round(d.startFontSize + delta),
        FONT_SIZE_RANGE.min,
        FONT_SIZE_RANGE.max,
      );
      onUpdateStyle({ fontSize });
    }
  };

  const endDrag = () => {
    dragRef.current = null;
    setResizing(false);
  };

  const containerStyle = getSubtitleContainerStyle(style, 0, 0, s);
  const textStyle: React.CSSProperties = {
    ...subtitleStyleToCSS(style, s),
    pointerEvents: 'auto',
    cursor: 'move',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  };

  return (
    <div ref={boxRef} className="absolute inset-0">
      <div style={containerStyle}>
        <span
          ref={textRef}
          style={textStyle}
          onPointerDown={startMove}
          onPointerMove={handleMove}
          onPointerUp={endDrag}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            if (!dragRef.current) setHovered(false);
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {text}
        </span>
      </div>

      {hovered && frame && (
        <div
          className="absolute border border-dashed border-primary/80 bg-primary/5"
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.w,
            height: frame.h,
            pointerEvents: 'none',
          }}
        >
          {resizing && (
            <span className="absolute -top-5 right-0 rounded bg-black/70 px-1 py-0.5 text-[10px] leading-none text-white">
              {style.fontSize}px
            </span>
          )}
          <div
            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-primary bg-primary"
            style={{ pointerEvents: 'auto' }}
            onPointerDown={startResize}
            onPointerMove={handleMove}
            onPointerUp={endDrag}
          />
        </div>
      )}
    </div>
  );
}
