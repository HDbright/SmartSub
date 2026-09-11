/**
 * 跟读录音波形条：
 * - live 模式：录音中，实时显示麦克风输入的滚动电平波形
 * - file 模式：对比播放，解码跟读录音 blob 绘制静态波形，并跟随回放画播放头
 * 置于原声大波形条上方，便于对照原声与跟读录音的波形差异。
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
  /** 播放头颜色（默认白色） */
  playheadColor?: string;
}

const BARS = 220;
const W = 1600;
const H = 160;
// 与小波形条（WaveformView overview）一致的绿系配色
const GREEN = '#4aa96c';
const GREEN_BRIGHT = '#7fdba4';

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
  const audioRef = useRef<HTMLAudioElement | null>(null);
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

  // live 模式：AnalyserNode 实时电平
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
    const hist: number[] = new Array(BARS).fill(0);
    let raf = 0;

    const draw = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
      hist.push(level);
      hist.shift();
      const cv = canvasRef.current;
      if (cv) {
        const g = cv.getContext('2d');
        if (g) {
          g.clearRect(0, 0, W, H);
          const bw = W / BARS;
          for (let i = 0; i < BARS; i++) {
            const bh = Math.max(2, hist[i] * H * 0.9);
            const grad = g.createLinearGradient(
              0,
              (H - bh) / 2,
              0,
              (H + bh) / 2,
            );
            grad.addColorStop(0, 'rgba(56, 189, 248, 0.95)');
            grad.addColorStop(1, 'rgba(56, 189, 248, 0.3)');
            g.fillStyle = grad;
            g.fillRect(i * bw + 1, (H - bh) / 2, Math.max(1, bw - 2), bh);
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

  // file 模式：绘制静态波形 + 回放播放头
  useEffect(() => {
    if (mode !== 'file') return;
    let raf = 0;
    const draw = () => {
      const cv = canvasRef.current;
      const g = cv?.getContext('2d');
      if (cv && g) {
        g.clearRect(0, 0, W, H);
        // 播放头：录音回放（audioEl）或外部进度函数（原声段）
        let px: number | null = null;
        if (
          audioEl &&
          !audioEl.paused &&
          isFinite(audioEl.duration) &&
          audioEl.duration > 0
        ) {
          px = (audioEl.currentTime / audioEl.duration) * W;
        } else if (progressFn) {
          const pr = progressFn();
          if (pr != null) px = pr * W;
        }
        const peaks = peaksProp ?? peaksRef.current;
        if (peaks.length) {
          const bw = W / peaks.length;
          for (let i = 0; i < peaks.length; i++) {
            const bh = Math.max(2, peaks[i] * H * 0.9);
            // 配色与小波形条一致：播放头之前亮绿，之后绿
            const played = px != null && (i + 0.5) * bw <= px;
            g.fillStyle = played ? GREEN_BRIGHT : GREEN;
            g.fillRect(i * bw + 0.5, (H - bh) / 2, Math.max(1, bw - 1), bh);
          }
        }
        if (px != null) {
          g.fillStyle = playheadColor;
          g.fillRect(Math.max(0, px - 1), 0, 2, H);
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
      <canvas ref={canvasRef} width={W} height={H} className="h-full w-full" />
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
