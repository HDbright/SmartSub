/**
 * 跟读录音中的画面中央叠加层：透明背景麦克风图案 + 实时录音电平波形。
 * - 电平来自 getUserMedia 流的 AnalyserNode（RMS），滚动柱状波形；
 * - pointer-events-none，不干扰视频画面点击；仅在录音阶段渲染。
 */

import React, { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';

interface Props {
  stream: MediaStream;
}

const BARS = 56;

export default function ShadowRecordingOverlay({ stream }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const micRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const history: number[] = new Array(BARS).fill(0);
    let raf = 0;

    const draw = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
      history.push(level);
      history.shift();

      const cv = canvasRef.current;
      if (cv) {
        const g = cv.getContext('2d');
        if (g) {
          const w = cv.width;
          const h = cv.height;
          g.clearRect(0, 0, w, h);
          const bw = w / BARS;
          for (let i = 0; i < BARS; i++) {
            const bh = Math.max(2, history[i] * h * 0.92);
            const grad = g.createLinearGradient(
              0,
              (h - bh) / 2,
              0,
              (h + bh) / 2,
            );
            grad.addColorStop(0, 'rgba(56, 189, 248, 0.95)');
            grad.addColorStop(1, 'rgba(56, 189, 248, 0.3)');
            g.fillStyle = grad;
            g.fillRect(i * bw + 1, (h - bh) / 2, Math.max(1, bw - 2), bh);
          }
        }
      }
      if (micRef.current) {
        micRef.current.style.opacity = String(0.5 + level * 0.5);
        micRef.current.style.transform = `scale(${1 + level * 0.12})`;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      void ctx.close().catch(() => {});
    };
  }, [stream]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
      <div
        ref={micRef}
        className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-sky-400/80 bg-black/50 text-sky-300 shadow-lg transition-transform"
      >
        <Mic className="h-8 w-8" />
      </div>
      <canvas ref={canvasRef} width={300} height={64} className="max-w-[82%]" />
    </div>
  );
}
