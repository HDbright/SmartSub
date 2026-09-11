# -*- coding: utf-8 -*-
"""RecordWaveStrip 支持外部 peaks/progressFn（原声段波形条用）"""
import io

p = 'renderer/components/repeat/RecordWaveStrip.tsx'
s = io.open(p, encoding='utf-8').read()

# 1. props 扩展
old = """interface Props {
  mode: 'live' | 'file';
  stream?: MediaStream | null;
  audioEl?: HTMLAudioElement | null;
  audioUrl?: string | null;
  label?: string;
  className?: string;
}"""
new = """interface Props {
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
}"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """  devices_placeholder"""
# no-op

old = """export default function RecordWaveStrip({
  mode,
  stream,
  audioEl,
  audioUrl,
  label,
  className,
}: Props) {"""
new = """export default function RecordWaveStrip({
  mode,
  stream,
  audioEl,
  audioUrl,
  label,
  className,
  peaks: peaksProp,
  progressFn,
}: Props) {"""
assert s.count(old) == 1
s = s.replace(old, new)

# 2. file 模式绘制：优先 peaksProp；播放头优先 progressFn
old = """    let raf = 0;
    const draw = () => {
      const cv = canvasRef.current;
      const g = cv?.getContext('2d');
      if (cv && g) {
        g.clearRect(0, 0, W, H);
        const peaks = peaksRef.current;
        const bw = W / Math.max(1, peaks.length);
        for (let i = 0; i < peaks.length; i++) {
          const bh = Math.max(2, peaks[i] * H * 0.9);
          g.fillStyle = 'rgba(129, 140, 248, 0.75)';
          g.fillRect(i * bw + 0.5, (H - bh) / 2, Math.max(1, bw - 1), bh);
        }
        if (audioEl && !audioEl.paused && isFinite(audioEl.duration)) {
          const px = (audioEl.currentTime / audioEl.duration) * W;
          g.fillStyle = 'rgba(255, 255, 255, 0.9)';
          g.fillRect(px - 1, 0, 2, H);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode, audioEl, decoded]);"""
new = """    let raf = 0;
    const draw = () => {
      const cv = canvasRef.current;
      const g = cv?.getContext('2d');
      if (cv && g) {
        g.clearRect(0, 0, W, H);
        const peaks = peaksProp ?? peaksRef.current;
        if (peaks.length) {
          const bw = W / peaks.length;
          for (let i = 0; i < peaks.length; i++) {
            const bh = Math.max(2, peaks[i] * H * 0.9);
            g.fillStyle = 'rgba(129, 140, 248, 0.75)';
            g.fillRect(i * bw + 0.5, (H - bh) / 2, Math.max(1, bw - 1), bh);
          }
        }
        // 播放头：录音回放（audioEl）或外部进度函数（原声段）
        let px: number | null = null;
        if (audioEl && !audioEl.paused && isFinite(audioEl.duration) && audioEl.duration > 0) {
          px = (audioEl.currentTime / audioEl.duration) * W;
        } else if (progressFn) {
          const p = progressFn();
          if (p != null) px = p * W;
        }
        if (px != null) {
          g.fillStyle = 'rgba(255, 255, 255, 0.9)';
          g.fillRect(Math.max(0, px - 1), 0, 2, H);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode, audioEl, decoded, peaksProp, progressFn]);"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('strip props ok')
