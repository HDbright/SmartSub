# -*- coding: utf-8 -*-
"""RepeatWorkbench：录音条下方追加 原声段波形条（对比时与录音条上下对照）"""
import io

p = 'renderer/components/repeat/RepeatWorkbench.tsx'
s = io.open(p, encoding='utf-8').read()

old = """                {/* 跟读录音波形条：录音中=麦克风实时波形；对比播放=跟读录音波形（原声大波形在下方对照） */}
                {(shadowPhase === 'rec' ||
                  ['cmp-orig', 'cmp-rec', 'gap'].includes(shadowPhase)) && (
                  <RecordWaveStrip
                    className="h-20"
                    mode={shadowPhase === 'rec' ? 'live' : 'file'}
                    stream={recStream}
                    audioEl={shadowAudioRef.current}
                    audioUrl={shadowUrlRef.current}
                    label={
                      shadowPhase === 'rec'
                        ? t('toast.shadowRecording')
                        : t('remote.aCompare')
                    }
                  />
                )}"""
new = """                {/* 跟读录音波形条（上）：录音中=麦克风实时波形；对比播放=跟读录音波形 */}
                {/* 原声段波形条（下）：当前跟读目标段（AB 区间/字幕句）的原声波形，上下对照比较 */}
                {(shadowPhase === 'rec' ||
                  ['cmp-orig', 'cmp-rec', 'gap'].includes(shadowPhase)) && (
                  <>
                    <RecordWaveStrip
                      className="h-20"
                      mode={shadowPhase === 'rec' ? 'live' : 'file'}
                      stream={recStream}
                      audioEl={shadowAudioRef.current}
                      audioUrl={shadowUrlRef.current}
                      label={
                        shadowPhase === 'rec'
                          ? t('toast.shadowRecording')
                          : t('remote.aCompare')
                      }
                    />
                    <RecordWaveStrip
                      className="h-20"
                      mode="file"
                      peaks={origSegmentPeaks}
                      progressFn={
                        ['orig', 'cmp-orig'].includes(shadowPhase)
                          ? () => {
                              const v = videoRef.current;
                              const cue = shadowCueRef.current;
                              if (!v || !cue || cue.end <= cue.start) return null;
                              return Math.max(
                                0,
                                Math.min(
                                  1,
                                  (v.currentTime - cue.start) /
                                    (cue.end - cue.start),
                                ),
                              );
                            }
                          : null
                      }
                      label={t('remote.waveOrig')}
                    />
                  </>
                )}"""
assert s.count(old) == 1, 'strip anchor'
s = s.replace(old, new)

# origSegmentPeaks memo（peaks=大波形峰值状态，duration=总时长）：插在 showWave 渲染之前不便，
# 放在 recStream state 旁（引擎块内已可访问 peaks/duration——均为组件状态）
old = """  const [recStream, setRecStream] = useState<MediaStream | null>(null);"""
new = """  const [recStream, setRecStream] = useState<MediaStream | null>(null);
  // 原声段波形峰值：从全曲峰值中切出当前跟读/对比目标段
  const origSegmentPeaks = useMemo(() => {
    const cue = shadowCueRef.current;
    if (!peaks?.length || !duration || !cue || duration <= 0) return null;
    const n = peaks.length;
    const i0 = Math.max(0, Math.floor((cue.start / duration) * n));
    const i1 = Math.min(n, Math.ceil((cue.end / duration) * n));
    if (i1 <= i0) return null;
    return peaks.slice(i0, i1);
    // shadowPhase 变化时重算（cue 快照在进入阶段时更新）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, duration, shadowPhase]);"""
assert s.count(old) == 1
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('orig strip ok')

# i18n
import json
for loc, val in [('zh', '原声'), ('en', 'Original')]:
    pp = f'renderer/public/locales/{loc}/repeat.json'
    d = json.load(open(pp, encoding='utf-8'))
    d.setdefault('remote', {})['waveOrig'] = val
    json.dump(d, open(pp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('i18n ok')
