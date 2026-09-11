# -*- coding: utf-8 -*-
"""RecordWaveStrip live 模式上报电平（供静音检测自动停止）"""
import io

p = 'renderer/components/repeat/RecordWaveStrip.tsx'
s = io.open(p, encoding='utf-8').read()

old = """  /** 播放头颜色 */
  playheadColor?: string;
}"""
new = """  /** 播放头颜色 */
  playheadColor?: string;
  /** live 模式每帧上报当前电平（0..1，已放大），供静音检测 */
  onLevel?: (level: number) => void;
}"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """  peaks: peaksProp,
  progressFn,
  playheadColor = 'rgba(255, 255, 255, 0.9)',
}: Props) {"""
new = """  peaks: peaksProp,
  progressFn,
  playheadColor = 'rgba(255, 255, 255, 0.9)',
  onLevel,
}: Props) {"""
assert s.count(old) == 1
s = s.replace(old, new)

# live 绘制中上报电平（每 3 帧一次，降低调用频率）
old = """      const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
      hist.push(level);
      hist.shift();"""
new = """      const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
      frame++;
      if (frame % 3 === 0) onLevel?.(level);
      hist.push(level);
      hist.shift();"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """    const hist: number[] = [];
    let raf = 0;

    const draw = () => {
      analyser.getByteTimeDomainData(data);"""
new = """    const hist: number[] = [];
    let frame = 0;
    let raf = 0;

    const draw = () => {
      analyser.getByteTimeDomainData(data);"""
assert s.count(old) == 1
s = s.replace(old, new)

# 依赖
old = """      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      void ctx.close().catch(() => {});
    };
  }, [mode, stream]);"""
new = """      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      void ctx.close().catch(() => {});
    };
  }, [mode, stream, onLevel]);"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('onLevel ok')
