# -*- coding: utf-8 -*-
"""对比两条波形配色与小波形条一致（绿系：播放头前亮绿 #7fdba4 / 后绿 #4aa96c）"""
import io

p = 'renderer/components/repeat/RecordWaveStrip.tsx'
s = io.open(p, encoding='utf-8').read()

# 模块级绿色常量
old = """const BARS = 220;
const W = 1600;
const H = 160;"""
new = """const BARS = 220;
const W = 1600;
const H = 160;
// 与小波形条（WaveformView overview）一致的绿系配色
const GREEN = '#4aa96c';
const GREEN_BRIGHT = '#7fdba4';"""
assert s.count(old) == 1
s = s.replace(old, new)

# file 绘制：先算播放头，再按播放进度着色（播放头前亮绿、后绿）
old = """    let raf = 0;
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
            const grad = g.createLinearGradient(0, (H - bh) / 2, 0, (H + bh) / 2);
            grad.addColorStop(0, 'rgba(199, 210, 254, 0.98)');
            grad.addColorStop(1, 'rgba(129, 140, 248, 0.55)');
            g.fillStyle = grad;
            g.fillRect(i * bw + 0.5, (H - bh) / 2, Math.max(1, bw - 1), bh);
          }
        }
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
        if (px != null) {
          g.fillStyle = playheadColor;
          g.fillRect(Math.max(0, px - 1), 0, 2, H);
        }
      }
      raf = requestAnimationFrame(draw);
    };"""
new = """    let raf = 0;
    const draw = () => {
      const cv = canvasRef.current;
      const g = cv?.getContext('2d');
      if (cv && g) {
        g.clearRect(0, 0, W, H);
        const peaks = peaksProp ?? peaksRef.current;
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
    };"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('green colors ok')
