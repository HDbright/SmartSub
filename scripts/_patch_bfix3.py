# -*- coding: utf-8 -*-
"""B± 微调：钳制发生时警告提示；toast 显示完整 A-B 区间；键码重复绑定时面板可见"""
import io

p = 'renderer/components/repeat/RepeatWorkbench.tsx'
s = io.open(p, encoding='utf-8').read()

old = """    } else {
      const b =
        Math.round(
          clamp(ab.b + delta, (ab.a ?? 0) + 0.3, duration || ab.b + delta),
        ) / 10;
      // 四舍五入后硬保底：B 永远不早于 A+0.3s
      const bSafe = Math.max(b, (ab.a ?? 0) + 0.3);
      abRef.current = { ...ab, b: bSafe };
      syncAb();
      // 播放头已越过新 B：立即从 A 重新开始循环（不等 timeupdate/间隔，避免观感卡顿后突跳）
      if (v && !v.seeking && v.currentTime >= bSafe - 0.02 && ab.a != null) {
        engineSeek(ab.a + 0.001);
        if (v.paused) void v.play().catch(() => {});
      }
      toast.info(t('toast.abAdjusted', { point: 'B', time: formatClock(bSafe) }));
    }
  };"""
new = """    } else {
      const lo = (ab.a ?? 0) + 0.3;
      const desired = ab.b + delta;
      const b =
        Math.round(clamp(desired, lo, duration || desired) * 10) / 10;
      // 四舍五入后硬保底：B 永远不早于 A+0.3s
      const bSafe = Math.max(b, lo);
      abRef.current = { ...ab, b: bSafe };
      syncAb();
      // 播放头已越过新 B：立即从 A 重新开始循环（不等 timeupdate/间隔，避免观感卡顿后突跳）
      if (v && !v.seeking && v.currentTime >= bSafe - 0.02 && ab.a != null) {
        engineSeek(ab.a + 0.001);
        if (v.paused) void v.play().catch(() => {});
      }
      // 钳制发生（B− 紧贴 A 或 B+ 到达片尾）：明确警告而非静默吸附
      if (desired < lo - 0.05 || (duration && desired > duration + 0.05)) {
        toast.warning(
          t('toast.abClamped', { point: 'B', time: formatClock(bSafe) }),
        );
      } else {
        toast.info(
          t('toast.abRange', {
            a: formatClock(ab.a ?? 0),
            b: formatClock(bSafe),
          }),
        );
      }
    }
  };"""
assert s.count(old) == 1, 'b branch anchor'
s = s.replace(old, new)

# A 分支 toast 也升级为区间显示
old = """      toast.info(t('toast.abAdjusted', { point: 'A', time: formatClock(aSafe) }));"""
new = """      toast.info(
        t('toast.abRange', { a: formatClock(aSafe), b: formatClock(ab.b ?? 0) }),
      );"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('workbench ok')

import json
for loc in ['zh', 'en']:
    pp = f'renderer/public/locales/{loc}/repeat.json'
    d = json.load(open(pp, encoding='utf-8'))
    if loc == 'zh':
        d['toast']['abRange'] = 'AB 区间 {{a}} → {{b}}'
        d['toast']['abClamped'] = '{{point}} 点已达边界：{{time}}（与另一点最小间隔 0.3 秒）'
    else:
        d['toast']['abRange'] = 'AB range {{a}} → {{b}}'
        d['toast']['abClamped'] = 'Point {{point}} hit the limit: {{time}} (min gap 0.3s)'
    json.dump(d, open(pp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('i18n ok')
