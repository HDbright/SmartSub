# -*- coding: utf-8 -*-
"""幂等应用 onLevel 相关五处修改"""
import io

p = 'renderer/components/repeat/RecordWaveStrip.tsx'
s = io.open(p, encoding='utf-8').read()
applied = []


def has(text):
    return text in s


def rep(tag, old, new):
    global s
    if new in s:
        applied.append(tag + ': already')
        return
    assert s.count(old) == 1, tag + ': missing old'
    s = s.replace(old, new)
    applied.append(tag + ': ok')


rep('report',
    """        const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
        hist.push(level);""",
    """        const level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
        frame++;
        if (frame % 3 === 0) onLevel?.(level);
        hist.push(level);""")

rep('frame',
    """    const hist: number[] = [];
    let raf = 0;

    const draw = () => {
      analyser.getByteTimeDomainData(data);""",
    """    const hist: number[] = [];
    let frame = 0;
    let raf = 0;

    const draw = () => {
      analyser.getByteTimeDomainData(data);""")

rep('props',
    """  /** 播放头颜色 */
  playheadColor?: string;
}""",
    """  /** 播放头颜色 */
  playheadColor?: string;
  /** live 模式每帧上报当前电平（0..1，已放大），供静音检测 */
  onLevel?: (level: number) => void;
}""")

rep('destructure',
    """  playheadColor = 'rgba(255, 255, 255, 0.9)',
}: Props) {""",
    """  playheadColor = 'rgba(255, 255, 255, 0.9)',
  onLevel,
}: Props) {""")

rep('deps',
    """      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      void ctx.close().catch(() => {});
    };
  }, [mode, stream]);""",
    """      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      void ctx.close().catch(() => {});
    };
  }, [mode, stream, onLevel]);""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('applied:', applied)
