# -*- coding: utf-8 -*-
"""跟读支持 AB 区间目标 + 音源互斥（修复失真）"""
import io

p = 'renderer/components/repeat/RepeatWorkbench.tsx'
s = io.open(p, encoding='utf-8').read()

edits = []

# 1. shadowActiveRef + setPhase 同步标记
old = """  const [shadowPhase, setShadowPhase] = useState<ShadowPhase>('idle');
  const shadowPhaseRef = useRef<ShadowPhase>('idle');
  const setPhase = (ph: ShadowPhase) => {
    shadowPhaseRef.current = ph;
    setShadowPhase(ph);
  };"""
new = """  const [shadowPhase, setShadowPhase] = useState<ShadowPhase>('idle');
  const shadowPhaseRef = useRef<ShadowPhase>('idle');
  // 跟读/对比进行中标记：让 AB 循环引擎暂时让位（否则句尾两套逻辑抢跳）
  const shadowActiveRef = useRef(false);
  const setPhase = (ph: ShadowPhase) => {
    shadowPhaseRef.current = ph;
    shadowActiveRef.current = ph !== 'idle';
    setShadowPhase(ph);
  };"""
edits.append((old, new))

# 2. AB 循环引擎让位
old = """    const ab = abRef.current;
    if (
      ab.state === 'loop' &&
      ab.a != null &&
      ab.b != null &&
      v.currentTime >= ab.b - 0.02
    ) {"""
new = """    const ab = abRef.current;
    if (
      ab.state === 'loop' &&
      ab.a != null &&
      ab.b != null &&
      !shadowActiveRef.current &&
      v.currentTime >= ab.b - 0.02
    ) {"""
edits.append((old, new))

# 3. playOrigSegment：先停录音音源（单一音源，消除叠加失真）
old = """  const playOrigSegment = (start: number, end: number) => {
    const v = videoRef.current;
    if (!v) return;
    shadowCueRef.current = { start, end };
    engineSeek(start + 0.001);
    void v.play().catch(() => {});
  };"""
new = """  const playOrigSegment = (start: number, end: number) => {
    const v = videoRef.current;
    if (!v) return;
    shadowCueRef.current = { start, end };
    shadowAudioRef.current?.pause(); // 单一音源：原声播放期间静默录音回放
    engineSeek(start + 0.001);
    void v.play().catch(() => {});
  };"""
edits.append((old, new))

# 4. playShadowRecording：先停视频（单一音源）
old = """    const a = shadowAudioRef.current;
    a.currentTime = 0;
    void a.play().catch(() => {});
    setPhase(phase);
  };"""
new = """    const a = shadowAudioRef.current;
    videoRef.current?.pause(); // 单一音源：录音回放期间静默原声
    a.currentTime = 0;
    void a.play().catch(() => {});
    setPhase(phase);
  };"""
edits.append((old, new))

# 5. resolveShadowSegment + toggleShadow 重写（AB 优先）
old = """  /** 手柄键：跟读录音（播原句→句尾自动录音→超时/手动结束→自动回放序列） */
  const toggleShadow = () => {
    if (shadowPhaseRef.current === 'rec') {
      stopShadowRecording(); // 手动提前结束，仍走自动回放序列
      return;
    }
    if (shadowPhaseRef.current !== 'idle') haltShadowPlayback();
    const i = activeCueIndex;
    if (i < 0 || !cues[i]) {
      toast.warning(t('toast.shadowNeedCue'));
      return;
    }
    if (singleRepeatRef.current) setSingleRepeat(false);
    stopAll();
    compareRef.current = false;
    playOrigSegment(
      cues[i].start,
      Math.max(cues[i].end, cues[i].start + 0.3),
    );
    setPhase('orig');
    startShadowWatcher();
    toast.info(t('toast.shadowStart'));
  };"""
new = """  /** 跟读/对比目标段：AB 循环激活 → AB 区间；否则当前字幕句 */
  const resolveShadowSegment = (): { start: number; end: number } | null => {
    const ab = abRef.current;
    if (ab.state === 'loop' && ab.a != null && ab.b != null) {
      return { start: ab.a, end: Math.max(ab.b, ab.a + 0.3) };
    }
    const i = activeCueIndex;
    if (i >= 0 && cues[i]) {
      return {
        start: cues[i].start,
        end: Math.max(cues[i].end, cues[i].start + 0.3),
      };
    }
    return null;
  };

  /** 手柄键：跟读录音（AB 循环激活跟读 AB 区间，否则当前句；句尾自动录音→超时/手动结束→自动回放序列） */
  const toggleShadow = () => {
    if (shadowPhaseRef.current === 'rec') {
      stopShadowRecording(); // 手动提前结束，仍走自动回放序列
      return;
    }
    if (shadowPhaseRef.current !== 'idle') haltShadowPlayback();
    const seg = resolveShadowSegment();
    if (!seg) {
      toast.warning(t('toast.shadowNeedCue'));
      return;
    }
    if (singleRepeatRef.current) setSingleRepeat(false);
    stopAll();
    compareRef.current = false;
    playOrigSegment(seg.start, seg.end);
    setPhase('orig');
    startShadowWatcher();
    toast.info(t('toast.shadowStart'));
  };"""
edits.append((old, new))

# 6. toggleCompare 目标段同样走 resolveShadowSegment
old = """    const cue =
      shadowCueRef.current ??
      (activeCueIndex >= 0 && cues[activeCueIndex]
        ? {
            start: cues[activeCueIndex].start,
            end: Math.max(
              cues[activeCueIndex].end,
              cues[activeCueIndex].start + 0.3,
            ),
          }
        : null);
    if (!cue) {
      toast.warning(t('toast.shadowNeedCue'));
      return;
    }"""
new = """    const cue = shadowCueRef.current ?? resolveShadowSegment();
    if (!cue) {
      toast.warning(t('toast.shadowNeedCue'));
      return;
    }"""
edits.append((old, new))

for idx, (old, new) in enumerate(edits):
    assert s.count(old) == 1, f'anchor {idx}: {old[:50]}'
    s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('all edits ok')
