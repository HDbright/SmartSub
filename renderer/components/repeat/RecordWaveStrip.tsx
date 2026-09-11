/**
 * 跟读录音波形条：
 * - live 模式：录音中，实时显示麦克风输入的滚动电平波形
 * - file 模式：对比播放，绘制波形（外部峰值或解码跟读录音），并跟随回放画播放头
 * canvas 按「元素实际尺寸 × 设备像素比」动态适配，波形锐利不模糊；
 * 配色与 WaveformView 小波形条一致（未播绿 #4aa96c / 已播亮绿 #7fdba4）。
 */

import React, { useEffect, useRef, useState } from 'react';
import { cn } from 'lib/utils';

interface Props {
  mode: 'live' | 'file';
  stream?: MediaStream | null;
  audioEl?: HTMLAudioElement | null;
  audioUrl?: string | null;
  label?: string;
  className?: string;
  /** 直接提供波形峰值（优先于 audioUrl 解码，用于原声段切片） */
  peaks?: number[] | null;
  /** 播放头进度（0..1），每帧读取；返回 null 则不画播放头 */
  progressFn?: () => number | null;
  /** 播放头颜色 */
  playheadColor?: string;
}

const GREEN = '#4aa96c';
const GREEN_BRIGHT = '#7fdba4';

/** 按 DPR 将 canvas 内部分辨率适配到元素实际尺寸（返回 {w,h}） */
function fitCanvas(cv: HTMLCanvasElement): { w: number; h: number } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  return { w, h };
}

export default function RecordWaveStrip({
  mode,
  stream,
  audioEl,
  audioUrl,
  label,
  className,
  peaks: peaksProp,
  progressFn,
  playheadColor = 'rgba(255, 255, 255, 0.9)',
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<number[]>([]);
  const [decoded, setDecoded] = useState(false);

  // file 模式：解码跟读录音 blob → 峰值数组
  useEffect(() => {
    if (mode !== 'file' || !audioUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctx();
        const buf = await (await fetch(audioUrl)).arrayBuffer();
        const audio = await ctx.decodeAudioData(buf);
        const ch = audio.getChannelData(0);
        const N = 800;
        const step = Math.max(1, Math.floor(ch.length / N));
        const peaks: number[] = [];
        for (let i = 0; i < N; i++) {
          let max = 0;
          const s0 = i * step;
          const s1 = Math.min(ch.length, s0 + step);
          for (let j = s0; j < s1; j++) {
            const v = Math.abs(ch[j]);
            if (v > max) max = v;
          }
          peaks.push(max);
        }
        void ctx.close().catch(() => {});
        if (cancelled) return;
        peaksRef.current = peaks;
        setDecoded(true);
      } catch {
        /* 解码失败按空波形处理 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, audioUrl]);

  // live 模式：AnalyserNode 实时电平滚动
  useEffect(() => {
    if (mode !== 'live' || !stream) return;
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const hist: number[] = [];
    let raf = 0;

    const draw = () => {
      const cv = canvasRef.current;
      if (cv) {
        const { w, h } = fitCanvas(cv);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
        hist.push(level);
        const bars = Math.max(40, Math.floor(w / 4));
        while (hist.length > bars) hist.shift();
        const g = cv.getContext('2d');
        if (g) {
          g.clearRect(0, 0, w, h);
          const bw = w / hist.length;
          for (let i = 0; i < hist.length; i++) {
            const bh = Math.max(2, hist[i] * h * 0.9);
            g.fillStyle = 'rgba(56, 189, 248, 0.9)';
            g.fillRect(i * bw + 0.5, (h - bh) / 2, Math.max(1, bw - 1.5), bh);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      void ctx.close().catch(() => {});
    };
  }, [mode, stream]);

  // file 模式：静态波形 + 播放头（每帧重绘，自动适配尺寸）
  useEffect(() => {
    if (mode !== 'file') return;
    let raf = 0;
    const draw = () => {
      const cv = canvasRef.current;
      if (cv) {
        const { w, h } = fitCanvas(cv);
        const g = cv.getContext('2d');
        if (g) {
          g.clearRect(0, 0, w, h);
          // 播放头：录音回放（audioEl）或外部进度函数（原声段）
          let px: number | null = null;
          if (
            audioEl &&
            !audioEl.paused &&
            isFinite(audioEl.duration) &&
            audioEl.duration > 0
          ) {
            px = (audioEl.currentTime / audioEl.duration) * w;
          } else if (progressFn) {
            const pr = progressFn();
            if (pr != null) px = pr * w;
          }
          const peaks = peaksProp ?? peaksRef.current;
          const n = peaks.length;
          if (n) {
            const bw = w / n;
            for (let i = 0; i < n; i++) {
              const bh = Math.max(2, peaks[i] * h * 0.9);
              const played = px != null && (i + 0.5) * bw <= px;
              g.fillStyle = played ? GREEN_BRIGHT : GREEN;
              g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw), bh);
            }
          }
          if (px != null) {
            g.fillStyle = playheadColor;
            g.fillRect(Math.max(0, px - 1), 0, 2, h);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode, audioEl, decoded, peaksProp, progressFn, playheadColor]);

  return (
    <div
      className={cn(
        'relative flex-shrink-0 overflow-hidden rounded-lg border border-sky-500/40 bg-slate-950',
        className,
      )}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
      {label && (
        <span
          className={cn(
            'absolute left-1.5 top-1 flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] leading-none text-sky-300',
            mode === 'live' && 'animate-pulse',
          )}
        >
          {mode === 'live' && (
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
          )}
          {label}
        </span>
      )}
    </div>
  );
}
