# -*- coding: utf-8 -*-
"""RecordWaveStrip file 绘制改为每物理像素聚合 min/max 列（与大波形同款算法，消除混叠模糊）"""
import io

p = 'renderer/components/repeat/RecordWaveStrip.tsx'
s = io.open(p, encoding='utf-8').read()

old = """        const peaks = peaksProp ?? peaksRef.current;
        const n = peaks.length;
        if (n) {
          const bw = w / n;
          for (let i = 0; i < n; i++) {
            const bh = Math.max(2, peaks[i] * h * 0.9);
            const played = px != null && (i + 0.5) * bw <= px;
            g.fillStyle = played ? GREEN_BRIGHT : GREEN;
            g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw), bh);
          }
        }"""
new = """        const peaks = peaksProp ?? peaksRef.current;
        const n = peaks.length;
        if (n) {
          // 每物理像素聚合一个 min/max 列（与大波形同款算法）：像素数少于数据桶时
          // 取窗口内最大幅值，多于数据桶时每桶一列，保证锐利不混叠
          const mid = h / 2;
          for (let x = 0; x < w; x++) {
            const s = Math.min(n - 1, Math.floor((x * n) / w));
            const e = Math.max(s + 1, Math.min(n, Math.floor(((x + 1) * n) / w)));
            let m = 0;
            for (let j = s; j < e; j++) m = Math.max(m, peaks[j]);
            const played = px != null && x + 0.5 <= px;
            const bh = Math.max(2, m * h * 0.92);
            g.fillStyle = played ? GREEN_BRIGHT : GREEN;
            g.fillRect(x, mid - bh / 2, 1, bh);
          }
        }"""
assert s.count(old) == 1, 'file draw anchor'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('per-pixel draw ok')

# 原声段切片桶数 1200 → 3000（高精度包络切片，供每像素聚合）
p2 = 'renderer/components/repeat/RepeatWorkbench.tsx'
s2 = io.open(p2, encoding='utf-8').read()
old2 = "    for (let i = 0; i < 1200; i++) {\n      const s0 = i0 + Math.floor((i * span) / 1200);\n      const s1 = Math.max(s0 + 1, i0 + Math.floor(((i + 1) * span) / 1200));"
assert s2.count(old2) == 1
s2 = s2.replace(old2, "    for (let i = 0; i < 3000; i++) {\n      const s0 = i0 + Math.floor((i * span) / 3000);\n      const s1 = Math.max(s0 + 1, i0 + Math.floor(((i + 1) * span) / 3000));")
old3 = "      out.push(m);\n    }\n    return out;\n    // shadowPhase"
new3 = "      out.push(m);\n    }\n    return out;\n    // shadowPhase 变化时重算（cue 快照在进入阶段时更新）"
# no-op 校验存在
io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('buckets 3000 ok')
