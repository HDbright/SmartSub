import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'next-i18next';
import { useRouter } from 'next/router';
import { toast } from 'sonner';
import {
  AudioLines,
  Captions,
  ChevronDown,
  ChevronUp,
  Combine,
  Eraser,
  Folder,
  Pilcrow,
  ListVideo,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRight,
  Pause,
  Play,
  Repeat,
  Save,
  Scissors,
  Search,
  Settings2,
  Tags,
  User,
  SkipBack,
  SkipForward,
  Square,
  Star,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/EmptyState';
import { useHotkeys } from 'hooks/useHotkeys';
import { cn, isAudioPath } from 'lib/utils';
import WaveformView from './WaveformView';
import RepeatSubtitleList from './RepeatSubtitleList';
import SubtitleProgressStrip from './SubtitleProgressStrip';
import MediaLibraryPanel, {
  type RepeatMediaContext,
} from './MediaLibraryPanel';
import PlaylistPanel, { type MediaPlayMode } from './PlaylistPanel';
import { useContextMenu, type ContextMenuItemDef } from './RepeatContextMenu';
import FavoriteCuesPanel from './FavoriteCuesPanel';
import { repeatPlaybackBus } from './playbackBus';
import {
  favoriteMedia,
  kindOf,
  pushRecent,
  removeRecent,
  useRepeatStore,
  type RecentMedia,
} from './mediaLibrary';
import {
  clamp,
  formatClock,
  formatSrtClock,
  groupByParagraph,
  groupBySpeaker,
  parseStartEndTime,
  GROUP_COLORS,
  type CueGroup,
  type GroupAssignment,
  type RepeatCue,
  type WavePeaks,
} from './repeatUtils';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { FavoriteCue } from './mediaLibrary';

/**
 * 视频复读工作台（复刻自 hedaoedu 课文复读功能）：
 * - 大小波形条：Web Audio 解码视频音轨，ocenaudio 式包络渲染，滚轮缩放/拖动平移/点击定位；
 * - AB 复读：单按钮四态（空闲 → 选 A → 选 B → 循环），可拖旗标微调，timeupdate 驱动回跳；
 * - 字幕列表：勾选片段、拖拽框选多段，「播放所选」整组循环或按设定遍数复读；
 * - 字幕可行内编辑并保存回原文件。
 */

type AbState = '' | 'pickA' | 'pickB' | 'loop';

interface QueueEngine {
  active: boolean;
  list: { start: number; end: number; idx: number }[];
  pos: number;
  pass: number;
  maxPass: number;
}

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const LOOP_OPTIONS = ['inf', '1', '2', '3', '5', '10'] as const;
type LoopMode = (typeof LOOP_OPTIONS)[number];

/** 拖拽/自动配对时识别的字幕扩展名（srt 优先） */
const SUBTITLE_EXTS = ['srt', 'vtt', 'ass', 'ssa', 'lrc'];

const REPEAT_CFG_KEY = 'repeatPlaybackCfg';

function loadPersistedCfg(): {
  rate?: number;
  loopMode?: LoopMode;
  showWave?: boolean;
  showList?: boolean;
  listWidth?: number;
  singleRepeat?: boolean;
} {
  try {
    return JSON.parse(localStorage.getItem(REPEAT_CFG_KEY) || '{}');
  } catch {
    return {};
  }
}

/** 确定性伪包络（真实解码完成前的占位，秒开） */
function makePseudoPeaks(seed: number): WavePeaks {
  const N = 2400;
  const min = new Float32Array(N);
  const max = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a =
      0.15 + 0.7 * (Math.abs(Math.sin(i * 12.9898 + seed) * 43758.5453) % 1);
    min[i] = -a * 0.45;
    max[i] = a;
  }
  return { min, max, n: N };
}

/** 从原始采样分桶求 min/max 包络（步进采样提速；大桶数不使用 spread 防 stack overflow） */
function buildPeaksFrom(ch: Float32Array, N: number): WavePeaks {
  const mn = new Float32Array(N);
  const mx = new Float32Array(N);
  const block = ch.length / N || 1;
  for (let i = 0; i < N; i++) {
    let lo = 0;
    let hi = 0;
    for (
      let j = Math.floor(i * block);
      j < Math.floor((i + 1) * block);
      j += 16
    ) {
      const v = ch[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mn[i] = lo;
    mx[i] = hi;
  }
  let g = 0.01;
  for (let i = 0; i < N; i++) {
    if (mx[i] > g) g = mx[i];
    if (-mn[i] > g) g = -mn[i];
  }
  for (let i = 0; i < N; i++) {
    mn[i] /= g;
    mx[i] /= g;
  }
  return { min: mn, max: mx, n: N };
}

const basename = (p: string) =>
  p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);

export default function RepeatWorkbench({
  active = true,
}: {
  active?: boolean;
}) {
  const { t } = useTranslation('repeat');

  // ---------- 媒体与字幕 ----------
  const [videoPath, setVideoPath] = useState('');
  const [subtitlePath, setSubtitlePath] = useState('');
  const [cues, setCues] = useState<RepeatCue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [mediaError, setMediaError] = useState(false);

  // ---------- 播放状态 ----------
  const videoRef = useRef<HTMLMediaElement | null>(null);
  const leftColRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRate] = useState(() => loadPersistedCfg().rate ?? 1);

  // ---------- 波形 ----------
  const [peaks, setPeaks] = useState<WavePeaks | null>(null);
  const [finePeaks, setFinePeaks] = useState<WavePeaks | null>(null);
  const [raw, setRaw] = useState<Float32Array | null>(null);
  const [waveSr, setWaveSr] = useState(44100);
  const [waveStatus, setWaveStatus] = useState<
    'idle' | 'loading' | 'ready' | 'failed'
  >('idle');
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoom, setZoom] = useState({ a: 0, b: 1 });
  const waveTokenRef = useRef(0);
  const mediaTokenRef = useRef(0);

  // ---------- 拖拽导入 ----------
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  // ---------- 媒体库 / 播放列表 / 最近播放 ----------
  const router = useRouter();
  const {
    library,
    setLibrary,
    playlists,
    setPlaylists,
    recents,
    setRecents,
    favorites,
    setFavorites,
    favGroups,
    setFavGroups,
  } = useRepeatStore();
  const [panelTab, setPanelTab] = useState<
    'subtitles' | 'library' | 'playlists' | 'favorites'
  >('subtitles');
  const [mediaPlayMode, setMediaPlayMode] = useState<MediaPlayMode>('once');
  const mediaQueueRef = useRef<{
    paths: string[];
    index: number;
    mode: MediaPlayMode;
  } | null>(null);
  const [mediaQueueUi, setMediaQueueUi] = useState<{
    count: number;
    index: number;
  } | null>(null);
  const autoPlayRef = useRef(false);
  const deepLinkDoneRef = useRef(false);
  const { openMenu, menuElement: homeMenuElement } = useContextMenu();

  // ---------- AB 复读（引擎数据在 ref，UI 镜像在 state） ----------
  const abRef = useRef<{
    state: AbState;
    a: number | null;
    b: number | null;
    repeats: number;
  }>({
    state: '',
    a: null,
    b: null,
    repeats: Infinity,
  });
  const [abUi, setAbUi] = useState<{
    state: AbState;
    a: number | null;
    b: number | null;
  }>({
    state: '',
    a: null,
    b: null,
  });
  const syncAb = () =>
    setAbUi({
      state: abRef.current.state,
      a: abRef.current.a,
      b: abRef.current.b,
    });

  // ---------- 多段复读队列 ----------
  const queueRef = useRef<QueueEngine>({
    active: false,
    list: [],
    pos: -1,
    pass: 1,
    maxPass: 1,
  });
  const [queueUi, setQueueUi] = useState<{
    active: boolean;
    pos: number;
    pass: number;
    maxPass: number;
    total: number;
  }>({ active: false, pos: -1, pass: 1, maxPass: 1, total: 0 });
  const syncQueue = () => {
    const q = queueRef.current;
    setQueueUi({
      active: q.active,
      pos: q.pos,
      pass: q.pass,
      maxPass: q.maxPass,
      total: q.list.length,
    });
  };

  const [selection, setSelection] = useState<Set<number>>(new Set());
  // 单句重复：勾选后当前播放的字幕句循环播放（橙色边框标识）
  const [singleRepeat, setSingleRepeat] = useState(
    () => loadPersistedCfg().singleRepeat === true,
  );
  const singleRepeatRef = useRef(singleRepeat);
  // 单句重复的循环锚点：点击定位的那一句。句尾越过依赖 timeupdate 粒度（约 250ms），
  // 播放头可能落进下一句范围内（相邻字幕间隙常 <0.3s），纯按"包含当前进度"找句会
  // 静默切换到下一句导致顺序播放，必须显式锚定。
  const singleRepeatCueRef = useRef<{ start: number; end: number } | null>(
    null,
  );
  const anchorSingleRepeatCue = useCallback(
    (t: number) => {
      let cue: RepeatCue | null = null;
      for (let i = 0; i < cues.length; i++) {
        if (cues[i].start <= t && cues[i].end > t) {
          cue = cues[i];
          break;
        }
      }
      singleRepeatCueRef.current = cue
        ? { start: cue.start, end: cue.end }
        : null;
    },
    [cues],
  );
  // 字幕搜索 / 替换
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  // 字幕分组（自动：说话人/自然段；手动：所选合并/移出）
  const [cueGroups, setCueGroups] = useState<GroupAssignment>({});
  const [cueGroupPicker, setCueGroupPicker] = useState<number | null>(null);
  const [pickerNewName, setPickerNewName] = useState('');
  const [splitIndex, setSplitIndex] = useState<number | null>(null);
  const [splitText, setSplitText] = useState('');
  const splitTextRef = useRef<HTMLTextAreaElement>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const [loopMode, setLoopMode] = useState<LoopMode>(() => {
    const saved = loadPersistedCfg().loopMode;
    return saved && LOOP_OPTIONS.includes(saved) ? saved : 'inf';
  });

  // ---------- 布局偏好：波形/字幕面板显隐、面板宽度、全屏 ----------
  const [showWave, setShowWave] = useState(
    () => loadPersistedCfg().showWave !== false,
  );
  const [showList, setShowList] = useState(
    () => loadPersistedCfg().showList !== false,
  );
  const [listWidth, setListWidth] = useState(() =>
    clamp(loadPersistedCfg().listWidth ?? 400, 260, 720),
  );
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    singleRepeatRef.current = singleRepeat;
  }, [singleRepeat]);

  // 偏好持久化
  useEffect(() => {
    try {
      localStorage.setItem(
        REPEAT_CFG_KEY,
        JSON.stringify({
          rate,
          loopMode,
          showWave,
          showList,
          listWidth,
          singleRepeat,
        }),
      );
    } catch {
      /* 忽略 */
    }
  }, [rate, loopMode, showWave, showList, listWidth, singleRepeat]);

  // 全屏状态同步（Esc 退出时复位按钮态）
  useEffect(() => {
    const onFsChange = () =>
      setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // 深链进入（命令面板搜索媒体库）：?mediaId=xxx 直接载入并播放
  useEffect(() => {
    if (deepLinkDoneRef.current || !router.isReady) return;
    const mediaId = router.query.mediaId;
    if (typeof mediaId !== 'string' || !mediaId) return;
    const media = library.media[mediaId];
    if (media) {
      deepLinkDoneRef.current = true;
      autoPlayRef.current = true;
      loadVideo(media.path);
    } else if (Object.keys(library.media).length) {
      deepLinkDoneRef.current = true; // 媒体已从库中删除，不再重试
    }
    // loadVideo 为稳定闭包依赖 mediaPath 等状态，故意不入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, router.query.mediaId, library]);

  /** 全屏播放：整个左列（画面 + 控制 + 波形）进入全屏，复读控制全程可用 */
  const toggleFullscreen = () => {
    const el = leftColRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => {});
  };

  // 画面单击暂停/继续：与双击全屏冲突，单击延时触发，双击时撤销未生效的单击
  const mediaClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMediaClick = () => {
    if (mediaClickTimerRef.current) return;
    mediaClickTimerRef.current = setTimeout(() => {
      mediaClickTimerRef.current = null;
      togglePlay();
    }, 220);
  };

  const handleMediaDoubleClick = () => {
    if (mediaClickTimerRef.current) {
      clearTimeout(mediaClickTimerRef.current);
      mediaClickTimerRef.current = null;
    }
    toggleFullscreen();
  };

  /** 拖拽调整字幕面板宽度（面板在右侧，向左拖 = 增宽） */
  const startListResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth;
    const move = (ev: PointerEvent) => {
      setListWidth(clamp(startW + (startX - ev.clientX), 260, 720));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = 'col-resize';
  };

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate, videoPath]);

  // ---------- 字幕定位 ----------
  const activeCueIndex = useMemo(() => {
    let found = -1;
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].start <= currentTime) {
        if (cues[i].end > currentTime) {
          found = i;
          break;
        }
      } else break;
    }
    return found;
  }, [cues, currentTime]);

  // ---------- 文件载入 ----------
  const chooseVideo = async () => {
    const res = await window?.ipc?.invoke('selectFile', {
      type: 'video',
      title: t('selectVideo'),
    });
    if (res?.canceled || !res?.filePath) return;
    stopMediaQueue();
    loadVideo(res.filePath as string);
  };

  const loadVideo = (path: string, explicitSubtitlePath?: string) => {
    stopAll();
    singleRepeatCueRef.current = null;
    waveTokenRef.current += 1;
    mediaTokenRef.current += 1;
    setVideoPath(path);
    setMediaError(false);
    setDuration(0);
    setCurrentTime(0);
    setCues([]);
    setSubtitlePath('');
    setSelection(new Set());
    setZoomOpen(false);
    setZoom({ a: 0, b: 1 });
    // 记录最近播放（同名自动配对成功后会回填 subtitlePath）
    setRecents((prev) =>
      pushRecent(prev, {
        path,
        name: basename(path),
        kind: kindOf(path),
        playedAt: Date.now(),
        subtitlePath: explicitSubtitlePath,
      }),
    );
    // 秒开占位伪包络，再异步解码真实波形
    setPeaks(makePseudoPeaks(path.length));
    setFinePeaks(null);
    setRaw(null);
    setWaveStatus('loading');
    void buildWave(path);
    if (explicitSubtitlePath) {
      // 拖拽同时带入字幕：以显式指定的为准，跳过同名自动匹配
      void loadSubtitle(explicitSubtitlePath, false, path);
      return;
    }
    // 自动配对同目录同名字幕（srt 优先，其次 vtt/ass/ssa/lrc）
    const token = mediaTokenRef.current;
    void autoMatchSubtitle(path).then((matched) => {
      if (matched && token === mediaTokenRef.current) {
        void loadSubtitle(matched, true, path);
      }
    });
  };

  /** 在视频所在目录查找同名同扩展名的字幕文件 */
  const autoMatchSubtitle = async (
    videoPath: string,
  ): Promise<string | null> => {
    const sepIdx = Math.max(
      videoPath.lastIndexOf('\\'),
      videoPath.lastIndexOf('/'),
    );
    if (sepIdx <= 0) return null;
    const dir = videoPath.slice(0, sepIdx);
    const sep = videoPath.includes('\\') ? '\\' : '/';
    const base = videoPath
      .slice(sepIdx + 1)
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
    try {
      const res = await window?.ipc?.invoke('getDirectoryFiles', {
        directoryPath: dir,
      });
      const files: string[] = res?.files || [];
      let best: string | null = null;
      let bestRank = Number.POSITIVE_INFINITY;
      for (const name of files) {
        const dot = name.lastIndexOf('.');
        if (dot <= 0) continue;
        if (name.slice(0, dot).toLowerCase() !== base) continue;
        const rank = SUBTITLE_EXTS.indexOf(name.slice(dot + 1).toLowerCase());
        if (rank >= 0 && rank < bestRank) {
          bestRank = rank;
          best = `${dir}${sep}${name}`;
        }
      }
      return best;
    } catch {
      return null;
    }
  };

  /** 解码视频音轨构建波形（fetch media:// → decodeAudioData，与 hedaoedu 同源方案） */
  const buildWave = async (path: string) => {
    const token = ++waveTokenRef.current;
    try {
      const res = await fetch(`media://${encodeURIComponent(path)}`);
      const buf = await res.arrayBuffer();
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ac = new AC();
      const audio = await ac.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      try {
        ac.close();
      } catch {
        /* 忽略 */
      }
      if (token !== waveTokenRef.current) return;
      const dur = ch.length / (audio.sampleRate || 44100);
      const overview = buildPeaksFrom(ch, 2400);
      // 高精度包络供无原始采样时的大波形缩放（约 100 列/秒，封顶防内存膨胀）
      const fineN = Math.min(480000, Math.max(2400, Math.ceil(dur * 100)));
      const fine = fineN > 2400 ? buildPeaksFrom(ch, fineN) : overview;
      // 原始采样仅保留约 16 分钟以内的音频（超出只留桶状包络，防渲染进程 OOM）
      const keepRaw = ch.length <= 48_000_000;
      setPeaks(overview);
      setFinePeaks(fine);
      setRaw(keepRaw ? ch : null);
      setWaveSr(audio.sampleRate || 44100);
      setWaveStatus('ready');
    } catch {
      if (token === waveTokenRef.current) setWaveStatus('failed');
    }
  };

  const chooseSubtitle = async () => {
    const res = await window?.ipc?.invoke('selectFile', {
      type: 'subtitle',
      title: t('loadSubtitle'),
    });
    if (res?.canceled) return;
    if (!res?.filePath) {
      toast.warning(t('toast.subtitleUnsupported'));
      return;
    }
    await loadSubtitle(res.filePath as string);
  };

  const loadSubtitle = async (
    path: string,
    silent = false,
    forVideoPath?: string,
  ) => {
    try {
      const entries = await window?.ipc?.invoke('readSubtitleFile', {
        filePath: path,
      });
      if (!Array.isArray(entries) || !entries.length) {
        if (!silent) toast.error(t('toast.subtitleLoadFailed'));
        return;
      }
      const mapped: RepeatCue[] = entries
        .map(
          (
            en: {
              id?: string;
              startEndTime?: string;
              content?: string[] | string;
            },
            i: number,
          ) => {
            const { start, end } = parseStartEndTime(en.startEndTime || '');
            const text = Array.isArray(en.content)
              ? en.content.join('\n')
              : (en.content as string) || '';
            return {
              id: en.id || String(i + 1),
              start,
              end: Math.max(end, start + 0.1),
              text,
            };
          },
        )
        .sort((a: RepeatCue, b: RepeatCue) => a.start - b.start);
      stopAll();
      setCues(mapped);
      setCueGroups({});
      setSubtitlePath(path);
      setSelection(new Set());
      setDirty(false);
      if (!silent)
        toast.success(t('toast.subtitleLoaded', { n: mapped.length }));
      // 回填最近播放记录的字幕路径，便于下次一键带字幕恢复
      const recentTarget = forVideoPath || videoPath;
      if (recentTarget) {
        setRecents((prev) =>
          prev.map((r) =>
            r.path === recentTarget ? { ...r, subtitlePath: path } : r,
          ),
        );
      }
    } catch {
      if (!silent) toast.error(t('toast.subtitleLoadFailed'));
    }
  };

  // ---------- 拖拽导入（Windows 资源管理器拖入视频 / 字幕） ----------
  const isSubtitlePath = (p: string) =>
    SUBTITLE_EXTS.includes(p.split('.').pop()?.toLowerCase() || '');

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // 子元素间移动会触发成对的 enter/leave，用深度计数避免误清除
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    const paths: string[] = [];
    const droppedFiles = e.dataTransfer.files;
    for (let i = 0; i < droppedFiles.length; i++) {
      // Electron 32+ 移除 File.path，优先 webUtils；旧 preload 场景回退 .path
      const p =
        window?.ipc?.getPathForFile?.(droppedFiles[i]) ??
        (droppedFiles[i] as unknown as { path?: string }).path;
      if (p) paths.push(p);
    }
    if (!paths.length) return;
    // 主进程统一校验过滤（'any' = 媒体 + 可导入字幕）
    let wrapped: { filePath: string }[] = [];
    try {
      wrapped = (await window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: 'any',
      })) as { filePath: string }[];
    } catch {
      return;
    }
    if (!Array.isArray(wrapped) || !wrapped.length) return;
    const media = wrapped.find((f) => !isSubtitlePath(f.filePath));
    const subtitle = wrapped.find((f) => isSubtitlePath(f.filePath));
    if (media) {
      // 视频（可同时带字幕）：loadVideo 内会自动配对同名字幕，显式字幕优先
      stopMediaQueue();
      loadVideo(media.filePath, subtitle?.filePath);
    } else if (subtitle) {
      if (videoPath) void loadSubtitle(subtitle.filePath);
      else toast.warning(t('toast.needVideoFirst'));
    }
  };

  // ---------- 媒体库 / 播放列表 / 最近播放 ----------
  /** 停止播放列表队列 */
  const stopMediaQueue = () => {
    mediaQueueRef.current = null;
    setMediaQueueUi(null);
  };

  /** 播放列表队列：从 index 起按模式顺序播放（ended 时推进） */
  const playMediaQueue = (
    paths: string[],
    index: number,
    mode: MediaPlayMode,
  ) => {
    const target = paths[index];
    if (!target) return;
    mediaQueueRef.current = { paths, index, mode };
    setMediaQueueUi({ count: paths.length, index });
    if (target === videoPath) {
      const v = videoRef.current;
      if (v && v.paused) void v.play().catch(() => {});
      return;
    }
    autoPlayRef.current = true;
    loadVideo(target);
  };

  /** 单个媒体播放（媒体库/点击行）：不建队列 */
  const playSingleMedia = (path: string) => {
    stopMediaQueue();
    if (path === videoPath) {
      const v = videoRef.current;
      if (v && v.paused) void v.play().catch(() => {});
      return;
    }
    autoPlayRef.current = true;
    loadVideo(path);
  };

  /** 最近播放记录回放：带上次使用过的字幕 */
  const playRecent = (item: RecentMedia) => {
    stopMediaQueue();
    autoPlayRef.current = true;
    loadVideo(item.path, item.subtitlePath);
  };

  const favoriteCurrent = () => {
    if (!videoPath) return;
    setLibrary(favoriteMedia(library, videoPath, null).data);
    toast.success(t('toast.favorited'));
    setPanelTab('library');
  };

  const mediaCtx: RepeatMediaContext = {
    library,
    setLibrary,
    playlists,
    setPlaylists,
    currentMediaPath: videoPath || null,
    onPlayMedia: playSingleMedia,
  };

  const formatAgo = (ts: number) => {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return t('recent.justNow');
    if (min < 60) return t('recent.minutesAgo', { n: min });
    const hours = Math.floor(min / 60);
    if (hours < 24) return t('recent.hoursAgo', { n: hours });
    return t('recent.daysAgo', { n: Math.floor(hours / 24) });
  };

  // ---------- 字幕句右键：归入指定分组 / 收藏此句 ----------
  const uniqueCueGroups = useMemo(() => {
    const map = new Map<number, CueGroup>();
    Object.values(cueGroups).forEach((g) => {
      if (!map.has(g.index)) map.set(g.index, g);
    });
    return Array.from(map.values()).sort((a, b) => a.index - b.index);
  }, [cueGroups]);

  // ---------- 分组管理：改名 / 调序（序号）/ 删组 ----------
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [managerRows, setManagerRows] = useState<
    { index: number; label: string; color: string; deleted: boolean }[]
  >([]);

  const openGroupManager = () => {
    setManagerRows(
      uniqueCueGroups.map((g) => ({
        index: g.index,
        label: g.label,
        color: g.color,
        deleted: false,
      })),
    );
    setGroupManagerOpen(true);
  };

  const moveManagerRow = (i: number, delta: number) => {
    setManagerRows((prev) => {
      const next = [...prev];
      const j = i + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  /** 应用：按行顺序重排序号（1..n），改名，删除的组摘除其句子的标记 */
  const applyGroupEdits = () => {
    const kept = managerRows.filter((r) => !r.deleted && r.label.trim());
    const oldToNew = new Map<
      number,
      { index: number; label: string; color: string }
    >();
    kept.forEach((r, i) =>
      oldToNew.set(r.index, {
        index: i + 1,
        label: r.label.trim(),
        color: r.color,
      }),
    );
    const deletedOld = new Set(
      managerRows.filter((r) => r.deleted).map((r) => r.index),
    );
    setCueGroups((prev) => {
      const next: GroupAssignment = {};
      Object.entries(prev).forEach(([id, g]) => {
        const n = oldToNew.get(g.index);
        if (n) next[id] = { index: n.index, label: n.label, color: n.color };
        else if (!deletedOld.has(g.index)) next[id] = g;
      });
      return next;
    });
    setGroupManagerOpen(false);
    toast.success(t('group.updated'));
  };

  const assignCueToGroup = (
    cueIndex: number,
    group: CueGroup | null,
    label: string,
  ) => {
    setCueGroups((prev) => {
      const next = { ...prev };
      if (group) next[cues[cueIndex].id] = group;
      else delete next[cues[cueIndex].id];
      return next;
    });
    if (group) toast.success(t('group.assigned', { label }));
  };

  const createAndAssignCueGroup = (cueIndex: number) => {
    const name = pickerNewName.trim();
    if (!name) return;
    const index =
      Object.values(cueGroups).reduce((m, g) => Math.max(m, g.index), 0) + 1;
    const group: CueGroup = {
      index,
      label: name,
      color: GROUP_COLORS[(index - 1) % GROUP_COLORS.length],
    };
    assignCueToGroup(cueIndex, group, name);
    setPickerNewName('');
    setCueGroupPicker(null);
  };

  // ---------- 字幕句合并 / 分拆 ----------
  /** 用若干句替换第 i 句（分拆）；保持时间轴与 id 语义 */
  const replaceCueWith = (i: number, parts: RepeatCue[]) => {
    stopAll();
    setCues((prev) => [...prev.slice(0, i), ...parts, ...prev.slice(i + 1)]);
    setSelection(new Set());
    setDirty(true);
  };

  const newCueId = () =>
    `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** 合并若干句（按时间顺序）：文本换行拼接，时间取首句起点到末句终点 */
  const mergeCues = (indices: number[]) => {
    if (indices.length < 2) {
      toast.warning(t('edit.needTwo'));
      return;
    }
    const sorted = indices.slice().sort((a, b) => a - b);
    const first = cues[sorted[0]];
    const last = cues[sorted[sorted.length - 1]];
    if (!first || !last) return;
    // 合并后的文字在同一行：句内换行与句间连接都归一为单个空格
    const mergedText = sorted
      .map((i) => cues[i].text.replace(/\n/g, ' ').trim())
      .filter((x) => x && x.trim())
      .join(' ');
    const insertAt = sorted[0];
    const removeSet = new Set(sorted);
    stopAll();
    setCues((prev) => {
      const next = prev.filter((_, i) => !removeSet.has(i));
      next.splice(insertAt, 0, {
        id: first.id,
        start: first.start,
        end: Math.max(last.end, first.start + 0.1),
        text: mergedText,
      });
      return next;
    });
    // 分组引用清理：保留首句 id 的标记，其余 id 摘除
    setCueGroups((prev) => {
      const next = { ...prev };
      sorted.slice(1).forEach((i) => {
        delete next[cues[i].id];
      });
      return next;
    });
    setSelection(new Set());
    setDirty(true);
    toast.success(t('edit.merged'));
  };

  const mergeWithPrev = (i: number) => {
    if (i <= 0) {
      toast.warning(t('edit.needPrev'));
      return;
    }
    mergeCues([i - 1, i]);
  };

  const mergeWithNext = (i: number) => {
    if (i >= cues.length - 1) {
      toast.warning(t('edit.needNext'));
      return;
    }
    mergeCues([i, i + 1]);
  };

  const openSplitDialog = (i: number) => {
    const cue = cues[i];
    if (!cue) return;
    setSplitIndex(i);
    setSplitText(cue.text);
  };

  /** 按行分拆：每行成为独立句，时长按字符数比例分配 */
  const splitByLines = () => {
    if (splitIndex == null) return;
    const cue = cues[splitIndex];
    if (!cue) return;
    const lines = cue.text.split('\n').filter((l) => l.trim());
    if (lines.length < 2) {
      toast.warning(t('edit.singleLine'));
      return;
    }
    const total = lines.reduce((s, l) => s + Math.max(1, l.length), 0);
    const dur = Math.max(0.2, cue.end - cue.start);
    let cursor = cue.start;
    const parts = lines.map((line, idx) => {
      const d = (Math.max(1, line.length) / total) * dur;
      const part = {
        id: idx === 0 ? cue.id : newCueId(),
        start: cursor,
        end: cursor + d,
        text: line.trim(),
      };
      cursor += d;
      return part;
    });
    replaceCueWith(splitIndex, parts);
    setSplitIndex(null);
    toast.success(t('edit.splitDone', { n: parts.length }));
  };

  /** 在光标处拆成两段：时长按左右文本长度比例分配 */
  const splitAtCaret = (caret: number) => {
    if (splitIndex == null) return;
    const cue = cues[splitIndex];
    if (!cue) return;
    const left = splitText.slice(0, caret).trim();
    const right = splitText.slice(caret).trim();
    if (!left || !right) {
      toast.warning(t('edit.splitInvalid'));
      return;
    }
    const ratio =
      splitText.slice(0, caret).length / Math.max(1, splitText.length);
    const mid = cue.start + (cue.end - cue.start) * ratio;
    replaceCueWith(splitIndex, [
      { id: cue.id, start: cue.start, end: mid, text: left },
      { id: newCueId(), start: mid, end: cue.end, text: right },
    ]);
    setSplitIndex(null);
    toast.success(t('edit.splitDone', { n: 2 }));
  };

  const favoriteCue = (i: number) => {
    const cue = cues[i];
    if (!cue) return;
    if (!subtitlePath) {
      toast.warning(t('fav.noSource'));
      return;
    }
    if (
      favorites.some(
        (f) =>
          f.sourceSubtitle === subtitlePath &&
          Math.abs(f.start - cue.start) < 0.01,
      )
    ) {
      toast.info(t('fav.exists'));
      return;
    }
    setFavorites((prev) => [
      {
        id: `fc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        text: cue.text,
        sourceSubtitle: subtitlePath,
        videoPath,
        start: cue.start,
        end: cue.end,
        createdAt: Date.now(),
        groupId: null,
      },
      ...prev,
    ]);
    toast.success(t('fav.added'));
  };

  /** 字幕行右键菜单 */
  const openCueContextMenu = (e: React.MouseEvent, i: number) => {
    const items: ContextMenuItemDef[] = [
      ...(cueGroups[cues[i]?.id]
        ? [
            {
              key: 'ungroup',
              label: t('group.removeFromGroup'),
              icon: Eraser,
              danger: true,
              onSelect: () => assignCueToGroup(i, null, ''),
            },
          ]
        : []),
      {
        key: 'mergePrev',
        label: t('edit.mergePrev'),
        icon: Combine,
        onSelect: () => mergeWithPrev(i),
      },
      {
        key: 'mergeNext',
        label: t('edit.mergeNext'),
        icon: Combine,
        onSelect: () => mergeWithNext(i),
      },
      {
        key: 'split',
        label: t('edit.split'),
        icon: Scissors,
        onSelect: () => openSplitDialog(i),
      },
      {
        key: 'group',
        label: t('group.assignPicker'),
        icon: Folder,
        onSelect: () => setCueGroupPicker(i),
      },
      {
        key: 'fav',
        label: t('fav.add'),
        icon: Star,
        onSelect: () => favoriteCue(i),
      },
    ];
    openMenu(e, items);
  };

  // ---------- 收藏句定位回播 ----------
  const playFavorite = (fav: FavoriteCue) => {
    if (videoPath === fav.videoPath && subtitlePath === fav.sourceSubtitle) {
      const idx = cues.findIndex((c) => Math.abs(c.start - fav.start) < 0.05);
      if (idx >= 0) activateCue(idx);
      else {
        stopAll();
        engineSeek(fav.start);
        void videoRef.current?.play().catch(() => {});
      }
      return;
    }
    if (!fav.videoPath) {
      toast.warning(t('fav.noVideo'));
      return;
    }
    pendingSeekRef.current = fav.start;
    stopMediaQueue();
    autoPlayRef.current = true;
    loadVideo(fav.videoPath, fav.sourceSubtitle);
  };

  const saveSubtitle = async () => {
    if (!subtitlePath) return;
    const subtitles = cues.map((c, i) => ({
      id: String(i + 1),
      startEndTime: `${formatSrtClock(c.start)} --> ${formatSrtClock(c.end)}`,
      sourceContent: c.text,
    }));
    try {
      const res = await window?.ipc?.invoke('saveSubtitleFile', {
        filePath: subtitlePath,
        subtitles,
        contentType: 'source',
      });
      if (res?.error) {
        toast.error(t('toast.saveFailed', { error: res.error }));
        return;
      }
      setDirty(false);
      toast.success(t('toast.saved'));
    } catch (e) {
      toast.error(t('toast.saveFailed', { error: String(e) }));
    }
  };

  // ---------- 播放控制 ----------
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || !videoPath) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  const seekTo = (sec: number) => {
    if (!videoRef.current || !videoPath) return;
    engineSeek(clamp(sec, 0, duration || sec));
    setCurrentTime(videoRef.current.currentTime);
    if (singleRepeatRef.current)
      anchorSingleRepeatCue(videoRef.current.currentTime);
  };

  const stopAb = (pauseAtB = false) => {
    const v = videoRef.current;
    abRef.current = { state: '', a: null, b: null, repeats: Infinity };
    syncAb();
    if (pauseAtB && v && !v.paused) v.pause();
  };

  const stopQueue = () => {
    queueRef.current = {
      active: false,
      list: [],
      pos: -1,
      pass: 1,
      maxPass: 1,
    };
    syncQueue();
  };

  const stopAll = () => {
    stopAb();
    stopQueue();
    const v = videoRef.current;
    if (v && !v.paused) v.pause();
  };

  const loopPasses = (mode: LoopMode) =>
    mode === 'inf' ? Infinity : parseInt(mode, 10);

  /** AB 单按钮：空闲 →(播放中取当前进度 / 停止中波形点选) 选 A → 选 B → 循环 → 清除 */
  const toggleAB = () => {
    if (!videoPath) return;
    const v = videoRef.current;
    const ab = abRef.current;
    if (ab.state === 'loop') {
      stopAb(false);
      return;
    }
    if (ab.state === 'pickA') {
      // 选点模式中再点按钮 = 取消 AB
      stopAb(false);
      return;
    }
    if (ab.state === 'pickB') {
      const b = v ? Math.min(v.duration || Infinity, v.currentTime) : 0;
      startAbLoop(ab.a, b);
      return;
    }
    if (ab.state === '') {
      stopQueue();
      if (v && !v.paused && v.duration) {
        ab.a = Math.round(v.currentTime * 10) / 10;
        ab.b = null;
        ab.state = 'pickB';
        syncAb();
      } else {
        ab.state = 'pickA';
        syncAb();
      }
    }
  };

  /** 设 A 点（快捷键 [ 或波形选点） */
  const setPointA = (sec?: number) => {
    if (!videoPath) return;
    const v = videoRef.current;
    const ab = abRef.current;
    const a = Math.round((sec ?? (v ? v.currentTime : 0)) * 10) / 10;
    stopQueue();
    ab.a = a;
    ab.b = null;
    ab.state = 'pickB';
    ab.repeats = loopPasses(loopMode);
    syncAb();
  };

  /** 设 B 点并开始循环（快捷键 ] 或波形选点） */
  const setPointB = (sec?: number) => {
    const v = videoRef.current;
    const ab = abRef.current;
    const b = Math.round((sec ?? (v ? v.currentTime : 0)) * 10) / 10;
    startAbLoop(ab.a, b);
  };

  const startAbLoop = (a: number | null, b: number) => {
    if (a == null || b == null || b <= a + 0.3) {
      toast.warning(t('abGapInvalid'));
      return;
    }
    const v = videoRef.current;
    abRef.current = {
      state: 'loop',
      a: Math.round(a * 10) / 10,
      b: Math.round(b * 10) / 10,
      repeats: loopPasses(loopMode),
    };
    syncAb();
    zoomToAB(abRef.current.a, abRef.current.b);
    if (v && v.paused) void v.play().catch(() => {});
  };

  /** AB 旗标拖动微调（保持 0.3s 最小间隔） */
  const dragAbPoint = (which: 'A' | 'B', sec: number) => {
    const ab = abRef.current;
    if (which === 'A') {
      const a = Math.round(clamp(sec, 0, (ab.b ?? duration) - 0.3) * 10) / 10;
      abRef.current = { ...ab, a };
    } else {
      const b =
        Math.round(clamp(sec, (ab.a ?? 0) + 0.3, duration || sec) * 10) / 10;
      abRef.current = { ...ab, b };
    }
    syncAb();
  };

  const wavePickPoint = (sec: number) => {
    const ab = abRef.current;
    if (ab.state === 'pickA') setPointA(sec);
    else if (ab.state === 'pickB') setPointB(sec);
  };

  const zoomToAB = (a: number, b: number) => {
    if (!duration || a == null || b == null) return;
    const ra = clamp(a / duration, 0, 1);
    const rb = clamp(b / duration, 0, 1);
    const span = clamp((rb - ra) * 1.3, 0.03, 1);
    const wa = clamp((ra + rb) / 2 - span / 2, 0, 1 - span);
    setZoom({ a: wa, b: wa + span });
    setZoomOpen(true);
  };

  /** 播放所选片段：构建队列，循环或按遍数复读 */
  const startSelectionPlayback = (sel: Set<number>) => {
    if (!videoPath || !cues.length) return;
    const indices = Array.from(sel).sort((a, b) => a - b);
    if (!indices.length) {
      toast.warning(t('list.selectionEmpty'));
      return;
    }
    stopAb();
    const list = indices.map((i) => ({
      start: cues[i].start,
      end: Math.max(cues[i].end, cues[i].start + 0.2),
      idx: i,
    }));
    queueRef.current = {
      active: true,
      list,
      pos: 0,
      pass: 1,
      maxPass: loopPasses(loopMode),
    };
    syncQueue();
    if (!videoRef.current) return;
    engineSeek(list[0].start + 0.001);
    void videoRef.current.play().catch(() => {});
  };

  /**
   * 勾选驱动的选择变更：
   * - 勾选一条 → 未在复读时自动开始「播放所选」；复读中则把新段追加进队列；
   * - 取消勾选一条 → 复读中从队列移除（移除当前段时自动跳到下一段）。
   */
  const handleSelectionChange = (
    next: Set<number>,
    source?: 'checkbox' | 'bulk',
  ) => {
    const prev = selection;
    const added = Array.from(next).filter((i) => !prev.has(i));
    const removed = Array.from(prev).filter((i) => !next.has(i));
    setSelection(next);
    // 单句重复开启时勾选只做选择，不启动/改动勾选队列
    if (singleRepeatRef.current) return;
    const q = queueRef.current;

    if (source === 'checkbox' && added.length === 1 && removed.length === 0) {
      const i = added[0];
      if (q.active) {
        if (!q.list.some((s) => s.idx === i)) {
          q.list.push({
            start: cues[i].start,
            end: Math.max(cues[i].end, cues[i].start + 0.2),
            idx: i,
          });
          syncQueue();
        }
      } else {
        startSelectionPlayback(next);
      }
      return;
    }

    if (
      source === 'checkbox' &&
      removed.length === 1 &&
      added.length === 0 &&
      q.active
    ) {
      const i = removed[0];
      const curIdx = q.pos >= 0 ? q.list[q.pos]?.idx : undefined;
      const nextList = q.list.filter((s) => s.idx !== i);
      if (!nextList.length) {
        stopQueue();
        return;
      }
      if (curIdx === i) {
        // 移除的是当前段：pos 保持指向原位置的下一个
        q.list = nextList;
        if (q.pos >= q.list.length) q.pos = 0;
        const v = videoRef.current;
        if (v) {
          engineSeek(q.list[q.pos].start + 0.001);
          if (v.paused) void v.play().catch(() => {});
        }
      } else {
        const newPos = nextList.findIndex((s) => s.idx === curIdx);
        q.list = nextList;
        q.pos = newPos >= 0 ? newPos : Math.min(q.pos, q.list.length - 1);
      }
      syncQueue();
    }
  };

  /** 上一条/下一条字幕跳转 */
  const jumpCue = (delta: number) => {
    if (!cues.length) return;
    let target = -1;
    if (delta > 0) {
      target = cues.findIndex((c) => c.start > currentTime + 0.05);
      if (target === -1) target = cues.length - 1;
    } else {
      for (let i = 0; i < cues.length; i++) {
        if (cues[i].start < currentTime - 0.15) target = i;
        else break;
      }
      if (target === -1) target = 0;
    }
    if (target >= 0) activateCue(target);
  };

  /** 单击字幕行：停止复读并定位播放 */
  const activateCue = (i: number) => {
    stopAll();
    if (!videoRef.current) return;
    if (singleRepeatRef.current) {
      singleRepeatCueRef.current = { start: cues[i].start, end: cues[i].end };
    }
    engineSeek(cues[i].start + 0.001);
    void videoRef.current.play().catch(() => {});
  };

  // ---------- 播放引擎：timeupdate 驱动 AB 回跳与队列推进 ----------
  // 程序化 seek 防护：seek 进行中引擎暂停判定。timeupdate 在 seek 完成前可能带着
  // 陈旧进度触发（>= 片段尾），若不防护会立刻再触发一次 seek，形成连环 seek 把解码器
  // 打爆（反复勾选字幕时致命卡顿的根因）。seeked 事件清除；800ms 兜底防死锁。
  const engineSeekGuardRef = useRef(false);
  const engineSeek = (sec: number) => {
    const el = videoRef.current;
    if (!el) return;
    engineSeekGuardRef.current = true;
    el.currentTime = sec;
    window.setTimeout(() => {
      engineSeekGuardRef.current = false;
    }, 800);
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    if (v.duration && isFinite(v.duration)) setDuration(v.duration);
    if (v.seeking || engineSeekGuardRef.current) return;

    // 单句重复：绝对优先——压过 AB 复读与勾选队列（循环次数），只循环锚定的那句
    if (singleRepeatRef.current) {
      if (!singleRepeatCueRef.current) anchorSingleRepeatCue(v.currentTime);
      const anchor = singleRepeatCueRef.current;
      if (anchor && v.currentTime >= anchor.end - 0.02) {
        engineSeek(anchor.start + 0.001);
      }
      return;
    }

    const ab = abRef.current;
    if (
      ab.state === 'loop' &&
      ab.a != null &&
      ab.b != null &&
      v.currentTime >= ab.b - 0.02
    ) {
      if (ab.repeats > 0) {
        ab.repeats -= 1;
        engineSeek(ab.a);
        if (v.paused) void v.play().catch(() => {});
      } else {
        stopAb(true); // 次数用完：停在 B 点
      }
      return;
    }

    const q = queueRef.current;
    if (q.active && q.pos >= 0 && q.list.length) {
      const seg = q.list[q.pos];
      if (v.currentTime >= seg.end - 0.03) {
        let nextPos = q.pos + 1;
        let pass = q.pass;
        if (nextPos >= q.list.length) {
          if (q.pass < q.maxPass) {
            pass += 1;
            nextPos = 0;
          } else {
            stopQueue();
            v.pause();
            return;
          }
        }
        q.pos = nextPos;
        q.pass = pass;
        syncQueue();
        engineSeek(q.list[nextPos].start + 0.001);
        if (v.paused) void v.play().catch(() => {});
        return;
      }
    }
  };

  /** ended 兜底：片段正好到媒体末尾时 timeupdate 可能不再触发 */
  const handleEnded = () => {
    setIsPlaying(false);
    const v0 = videoRef.current;
    if (v0 && (v0.seeking || engineSeekGuardRef.current)) return;
    // 单句重复：ended 回到锚定句句首（绝对优先，压过 AB 与勾选队列）
    if (singleRepeatRef.current) {
      let start = singleRepeatCueRef.current?.start;
      if (start == null) {
        const t = v0 ? v0.currentTime : duration;
        for (let i = 0; i < cues.length; i++) {
          if (cues[i].start <= t) start = cues[i].start;
          else break;
        }
      }
      if (v0 && start != null) {
        engineSeek(start + 0.001);
        void v0.play().catch(() => {});
      }
      return;
    }
    const q = queueRef.current;
    if (q.active && q.pos >= 0) {
      const seg = q.list[q.pos];
      if (seg && Math.abs(duration - seg.end) < 0.2) {
        let nextPos = q.pos + 1;
        let pass = q.pass;
        if (nextPos >= q.list.length) {
          if (q.pass < q.maxPass) {
            pass += 1;
            nextPos = 0;
          } else {
            stopQueue();
            return;
          }
        }
        q.pos = nextPos;
        q.pass = pass;
        syncQueue();
        const v = videoRef.current;
        if (v) {
          engineSeek(q.list[nextPos].start + 0.001);
          void v.play().catch(() => {});
        }
        return;
      }
    }
    const ab = abRef.current;
    if (ab.state === 'loop' && ab.a != null) {
      const v = videoRef.current;
      if (v && ab.repeats > 0) {
        ab.repeats -= 1;
        engineSeek(ab.a);
        void v.play().catch(() => {});
        return;
      }
      stopAb();
      return;
    }

    // 播放列表队列推进：顺序 / 列表循环 / 单曲循环
    const mq = mediaQueueRef.current;
    if (mq) {
      const v = videoRef.current;
      if (!v) return;
      if (mq.mode === 'loopOne') {
        engineSeek(0);
        void v.play().catch(() => {});
        return;
      }
      let next = mq.index + 1;
      if (next >= mq.paths.length) {
        if (mq.mode === 'loopList') next = 0;
        else {
          stopMediaQueue();
          return;
        }
      }
      mq.index = next;
      setMediaQueueUi({ count: mq.paths.length, index: next });
      autoPlayRef.current = true;
      engineSeekGuardRef.current = false;
      loadVideo(mq.paths[next]);
    }
  };

  // ---------- 快捷键（仅复读页可见时生效；保活挂载下切页后自动失能） ----------
  useHotkeys(
    active
      ? [
          { combo: 'space', handler: () => togglePlay() },
          { combo: 'arrowleft', handler: () => seekTo(currentTime - 5) },
          { combo: 'arrowright', handler: () => seekTo(currentTime + 5) },
          { combo: 'arrowup', handler: () => jumpCue(-1) },
          { combo: 'arrowdown', handler: () => jumpCue(1) },
          { combo: '[', handler: () => setPointA() },
          {
            combo: ']',
            handler: () =>
              abRef.current.state === 'pickB' ? setPointB() : setPointA(),
          },
          { combo: 'f', handler: () => toggleFullscreen() },
          {
            combo: 'mod+f',
            allowInInput: true,
            handler: () => setSearchOpen(true),
          },
          { combo: 'escape', handler: () => stopAll() },
        ]
      : [],
  );

  // ---------- 底部迷你播放条总线：广播状态 / 接收命令 ----------
  useEffect(() => {
    repeatPlaybackBus.emitStatus({
      hasMedia: !!videoPath,
      playing: isPlaying,
      currentTime,
      duration,
    });
  }, [videoPath, isPlaying, currentTime, duration]);

  useEffect(() => {
    return repeatPlaybackBus.onCommand((cmd) => {
      if (cmd === 'toggle') togglePlay();
      else if (cmd === 'stop') stopAll();
      else if (cmd === 'next') jumpCue(1);
      else if (cmd === 'prev') jumpCue(-1);
    });
  });

  // ---------- 字幕搜索 / 替换 ----------
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    return cues
      .filter((c) => c.text.toLowerCase().includes(q))
      .map((c) => c.id);
  }, [cues, searchQuery]);

  const activeMatchId = searchMatches.length
    ? searchMatches[matchIndex % searchMatches.length]
    : null;

  const gotoMatch = (delta: number) => {
    if (!searchMatches.length) return;
    setMatchIndex(
      (i) => (i + delta + searchMatches.length) % searchMatches.length,
    );
  };

  const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const replaceInText = (text: string, q: string, r: string) =>
    text.replace(new RegExp(escapeRegExp(q), 'gi'), r);

  const countInText = (text: string, q: string) =>
    (text.match(new RegExp(escapeRegExp(q), 'gi')) || []).length;

  const replaceCurrentMatch = () => {
    const q = searchQuery.trim();
    if (!q || !activeMatchId) return;
    setCues((prev) =>
      prev.map((c) =>
        c.id === activeMatchId
          ? { ...c, text: replaceInText(c.text, q, replaceQuery) }
          : c,
      ),
    );
    setDirty(true);
  };

  const replaceAllMatches = () => {
    const q = searchQuery.trim();
    if (!q) return;
    let count = 0;
    setCues((prev) =>
      prev.map((c) => {
        if (!c.text.toLowerCase().includes(q.toLowerCase())) return c;
        count += countInText(c.text, q);
        return { ...c, text: replaceInText(c.text, q, replaceQuery) };
      }),
    );
    setDirty(true);
    toast.success(t('toast.replaceAllDone', { n: count }));
  };

  // ---------- 字幕分组 ----------
  const applySpeakerGroups = () => {
    const { assignment, count } = groupBySpeaker(cues);
    if (!count) {
      toast.warning(t('group.noSpeaker'));
      return;
    }
    setCueGroups(assignment);
    toast.success(t('group.done', { n: count }));
  };

  const applyParagraphGroups = () => {
    const { assignment, count } = groupByParagraph(cues, 1.5, (n) =>
      t('group.paragraphLabel', { n }),
    );
    setCueGroups(assignment);
    toast.success(t('group.done', { n: count }));
  };

  /** 手动：所选合并为一组——若所选中已有分组则并入该组，否则新建 */
  const mergeSelectionToGroup = () => {
    const indices = Array.from(selection);
    if (!indices.length) {
      toast.warning(t('group.needSelection'));
      return;
    }
    let target: CueGroup | null = null;
    for (const i of indices) {
      const g = cueGroups[cues[i].id];
      if (g) {
        target = g;
        break;
      }
    }
    let label: string;
    let color: string;
    let index: number;
    if (target) {
      ({ index, label, color } = target);
    } else {
      index =
        Object.values(cueGroups).reduce((m, g) => Math.max(m, g.index), 0) + 1;
      label = t('group.groupLabel', { n: index });
      color = GROUP_COLORS[(index - 1) % GROUP_COLORS.length];
    }
    const next = { ...cueGroups };
    indices.forEach((i) => {
      next[cues[i].id] = { index, label, color };
    });
    setCueGroups(next);
    toast.success(t('group.assigned', { label }));
  };

  /** 手动：把所选句子移出分组 */
  const removeSelectionFromGroups = () => {
    if (!selection.size) {
      toast.warning(t('group.needSelection'));
      return;
    }
    const next = { ...cueGroups };
    let removed = 0;
    selection.forEach((i) => {
      const id = cues[i].id;
      if (next[id]) {
        delete next[id];
        removed += 1;
      }
    });
    setCueGroups(next);
    toast.success(t('group.removed', { n: removed }));
  };

  // ---------- 波形字幕段带 ----------
  const waveSegments = useMemo(
    () =>
      cues.map((c, i) => ({
        start: c.start,
        end: c.end,
        selected: selection.has(i),
        active:
          queueUi.active && queueUi.pos >= 0
            ? queueRef.current.list[queueUi.pos]?.idx === i
            : i === activeCueIndex,
      })),
    [cues, selection, activeCueIndex, queueUi],
  );

  const abPickForWave: 'A' | 'B' | null =
    abUi.state === 'pickA' ? 'A' : abUi.state === 'pickB' ? 'B' : null;
  const showAbPoints =
    abUi.state === 'loop' || abUi.state === 'pickB' || abUi.state === 'pickA';

  // ---------- 渲染 ----------
  const isAudioMedia = isAudioPath(videoPath);
  const mediaHandlers = {
    onTimeUpdate: handleTimeUpdate,
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      setDuration(e.currentTarget.duration || 0);
      // 收藏句定位：元数据就绪后先跳到句首
      if (pendingSeekRef.current != null) {
        engineSeek(pendingSeekRef.current);
        pendingSeekRef.current = null;
      }
      // 播放列表/媒体库/最近播放发起的载入自动起播
      if (autoPlayRef.current) {
        autoPlayRef.current = false;
        void e.currentTarget.play().catch(() => {});
      }
    },
    onPlay: () => setIsPlaying(true),
    onPause: () => setIsPlaying(false),
    onEnded: handleEnded,
    onSeeked: () => {
      engineSeekGuardRef.current = false;
    },
    onError: () => setMediaError(true),
  };
  const dropHandlers = {
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };
  const dragOverlay = dragOver ? (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/5">
      <span className="rounded-md bg-background/95 px-3 py-1.5 text-sm font-medium text-primary shadow-md">
        {t('drop.hint')}
      </span>
    </div>
  ) : null;

  if (!videoPath) {
    return (
      <div {...dropHandlers} className="relative h-full">
        <div className="flex h-full items-center justify-center overflow-y-auto">
          <div className="flex w-full max-w-md flex-col items-center gap-4 py-4">
            <EmptyState
              icon={Repeat}
              title={t('noVideoTitle')}
              description={t('noVideoDesc')}
              action={
                <Button onClick={chooseVideo}>
                  <Video className="h-4 w-4" />
                  {t('selectVideo')}
                </Button>
              }
              className="w-full"
            />
            {recents.length > 0 && (
              <div className="w-full">
                <div className="mb-1 flex items-center gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('recent.title')}
                  </span>
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-[11px] text-muted-foreground"
                    onClick={() => setRecents([])}
                  >
                    {t('recent.clear')}
                  </Button>
                </div>
                <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-card p-1.5">
                  {recents.slice(0, 10).map((r) => (
                    <div
                      key={r.path}
                      onClick={() => playRecent(r)}
                      onContextMenu={(e) =>
                        openMenu(e, [
                          {
                            key: 'play',
                            label: t('recent.play'),
                            icon: Play,
                            onSelect: () => playRecent(r),
                          },
                          {
                            key: 'fav',
                            label: t('recent.favorite'),
                            icon: Star,
                            onSelect: () => {
                              setLibrary(
                                favoriteMedia(library, r.path, null).data,
                              );
                              toast.success(t('toast.favorited'));
                            },
                          },
                          {
                            key: 'remove',
                            label: t('recent.remove'),
                            icon: X,
                            danger: true,
                            onSelect: () =>
                              setRecents((prev) => removeRecent(prev, r.path)),
                          },
                        ])
                      }
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent"
                      title={r.path}
                    >
                      {r.kind === 'audio' ? (
                        <AudioLines className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      ) : (
                        <Video className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      {r.subtitlePath && (
                        <Captions className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      )}
                      <span className="flex-shrink-0 text-[10.5px] text-faint">
                        {formatAgo(r.playedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        {homeMenuElement}
        {dragOverlay}
      </div>
    );
  }

  return (
    <div {...dropHandlers} className="relative h-full">
      <div className="flex h-full min-h-0 flex-col gap-2.5">
        {/* 顶部工具行 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={chooseVideo}>
            <Video className="h-3.5 w-3.5" />
            {t('selectVideo')}
          </Button>
          <Button variant="outline" size="sm" onClick={chooseSubtitle}>
            <Captions className="h-3.5 w-3.5" />
            {t('loadSubtitle')}
          </Button>
          <Button
            size="sm"
            onClick={saveSubtitle}
            disabled={!subtitlePath || !cues.length || !dirty}
            title={dirty ? t('saveSubtitle') : t('list.saveNoChange')}
          >
            <Save className="h-3.5 w-3.5" />
            {t('saveSubtitle')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={favoriteCurrent}
            disabled={!videoPath}
            title={t('library.favoriteCurrent')}
          >
            <Star className="h-3.5 w-3.5" />
            {t('library.favoriteCurrent')}
          </Button>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className="max-w-[220px] truncate"
              title={basename(videoPath)}
            >
              {basename(videoPath)}
            </span>
            {subtitlePath && (
              <>
                <span className="text-faint">/</span>
                <span
                  className={cn(
                    'max-w-[220px] truncate',
                    dirty && 'text-primary',
                  )}
                  title={subtitlePath}
                >
                  {basename(subtitlePath)}
                  {dirty ? ' *' : ''}
                </span>
              </>
            )}
          </span>
          <span className="flex-1" />
          {waveStatus === 'loading' && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('toast.waveAnalyzing')}
            </span>
          )}
          {waveStatus === 'failed' && (
            <span className="text-xs text-warning">
              {t('toast.waveFailed')}
            </span>
          )}
          {mediaQueueUi && (
            <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
              <ListVideo className="h-3.5 w-3.5" />
              <span className="tnum">
                {t('playlist.playing', {
                  index: mediaQueueUi.index + 1,
                  count: mediaQueueUi.count,
                })}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-0.5 px-1.5 text-[11px]"
                onClick={stopMediaQueue}
              >
                <Square className="h-2.5 w-2.5" />
                {t('list.stop')}
              </Button>
            </span>
          )}
          <span className="flex flex-shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'h-7 w-7',
                showList ? 'text-primary' : 'text-muted-foreground',
              )}
              onClick={() => setShowList((v) => !v)}
              title={t('toggleList')}
              aria-label={t('toggleList')}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </span>
        </div>

        <div className="flex min-h-0 flex-1 gap-1">
          {/* 左侧：媒体 + 控制 + 波形（全屏目标容器，复读控制在全屏下仍可用） */}
          <div
            ref={leftColRef}
            className={cn(
              'flex min-w-0 flex-1 flex-col gap-2',
              isFullscreen && 'bg-background p-2',
            )}
          >
            <div
              className="relative flex min-h-0 flex-1 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-border bg-black"
              onClick={handleMediaClick}
              onDoubleClick={handleMediaDoubleClick}
              title={t('mediaClickHint')}
            >
              {mediaError ? (
                <div className="flex h-40 items-center text-sm text-white/70">
                  {t('toast.videoError')}
                </div>
              ) : isAudioMedia ? (
                <>
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <AudioLines className="h-12 w-12" />
                    <span className="max-w-[80%] truncate text-sm text-foreground">
                      {basename(videoPath)}
                    </span>
                    <span className="text-xs">{t('audioMode')}</span>
                  </div>
                  <audio
                    ref={(el) => {
                      videoRef.current = el;
                    }}
                    src={`media://${encodeURIComponent(videoPath)}`}
                    className="hidden"
                    {...mediaHandlers}
                  />
                </>
              ) : (
                <video
                  ref={(el) => {
                    videoRef.current = el;
                  }}
                  src={`media://${encodeURIComponent(videoPath)}`}
                  className="h-full w-full object-contain"
                  {...mediaHandlers}
                />
              )}
            </div>

            {/* 波形区（可整块隐藏） */}
            {showWave && (
              <>
                {/* 大波形（缩放视图） */}
                {zoomOpen && (
                  <div className="relative h-36 flex-shrink-0 overflow-hidden rounded-lg border border-border bg-slate-950">
                    <WaveformView
                      variant="zoom"
                      peaks={peaks}
                      finePeaks={finePeaks}
                      raw={raw}
                      sampleRate={waveSr}
                      duration={duration}
                      playing={isPlaying}
                      getPlayhead={() => videoRef.current?.currentTime ?? 0}
                      abA={showAbPoints ? abUi.a : null}
                      abB={showAbPoints ? abUi.b : null}
                      abPick={abPickForWave}
                      zoom={zoom}
                      onZoomChange={setZoom}
                      onOpenZoom={() => setZoomOpen(true)}
                      onSeek={seekTo}
                      onABPoint={wavePickPoint}
                      onABDrag={dragAbPoint}
                    />
                    <button
                      type="button"
                      aria-label={t('wave.closeZoom')}
                      onClick={() => {
                        setZoomOpen(false);
                        setZoom({ a: 0, b: 1 });
                      }}
                      className="absolute right-1.5 top-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-white/80 hover:bg-white/20"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}

                {/* 小波形（全时间轴总览） */}
                <div className="relative h-14 flex-shrink-0 overflow-hidden rounded-lg border border-border bg-slate-950">
                  <WaveformView
                    variant="overview"
                    peaks={peaks}
                    finePeaks={finePeaks}
                    raw={raw}
                    sampleRate={waveSr}
                    duration={duration}
                    playing={isPlaying}
                    getPlayhead={() => videoRef.current?.currentTime ?? 0}
                    abA={showAbPoints ? abUi.a : null}
                    abB={showAbPoints ? abUi.b : null}
                    abPick={abPickForWave}
                    zoom={zoom}
                    onZoomChange={setZoom}
                    onOpenZoom={() => setZoomOpen(true)}
                    onSeek={seekTo}
                    onABPoint={wavePickPoint}
                    onABDrag={dragAbPoint}
                  />
                  <button
                    type="button"
                    aria-label={
                      zoomOpen ? t('wave.closeZoom') : t('wave.openZoom')
                    }
                    onClick={() => {
                      if (zoomOpen) {
                        setZoomOpen(false);
                        setZoom({ a: 0, b: 1 });
                      } else {
                        const span = 0.4;
                        const head = duration
                          ? clamp(currentTime / duration, 0, 1)
                          : 0;
                        const a = clamp(head - span / 2, 0, 1 - span);
                        setZoom({ a, b: a + span });
                        setZoomOpen(true);
                      }
                    }}
                    className="absolute right-1.5 top-1.5 rounded bg-white/10 p-1 text-white/80 hover:bg-white/20"
                  >
                    {zoomOpen ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronUp className="h-3 w-3" />
                    )}
                  </button>
                </div>
              </>
            )}

            {/* 字幕进度指示条（波形与控制栏之间，点击/拖动定位） */}
            {cues.length > 0 && (
              <div className="h-3 flex-shrink-0 overflow-hidden rounded-full border border-border bg-slate-950">
                <SubtitleProgressStrip
                  segments={waveSegments}
                  duration={duration}
                  getPlayhead={() => videoRef.current?.currentTime ?? 0}
                  onSeek={seekTo}
                />
              </div>
            )}

            {/* AB 选点引导 */}
            {abPickForWave && (
              <div className="flex-shrink-0 rounded-md border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-primary">
                {abPickForWave === 'A' ? t('ab.hintPickA') : t('ab.hintPickB')}
              </div>
            )}

            {/* 走带控制条 */}
            <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t('prevSubtitle')}
                onClick={() => jumpCue(-1)}
              >
                <SkipBack className="h-4 w-4" />
              </Button>
              <Button size="sm" className="w-[76px]" onClick={togglePlay}>
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {isPlaying ? t('pause') : t('play')}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t('nextSubtitle')}
                onClick={() => jumpCue(1)}
              >
                <SkipForward className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                aria-label={t('stop')}
                onClick={stopAll}
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
              <span className="mx-1 font-mono text-xs text-muted-foreground tnum">
                {formatClock(currentTime)} / {formatClock(duration)}
              </span>
              <span className="mx-1 h-4 w-px bg-border" />
              {/* AB 复读：单按钮四态 */}
              <Button
                variant="outline"
                size="sm"
                onClick={toggleAB}
                className={cn(
                  'gap-1',
                  abUi.state === 'pickA' || abUi.state === 'pickB'
                    ? 'border-primary/60 bg-primary/15 text-primary'
                    : abUi.state === 'loop'
                      ? 'border-amber-500/70 bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      : '',
                )}
                title={
                  abUi.state === 'loop'
                    ? t('ab.tipLoop')
                    : abUi.state === 'pickB'
                      ? t('ab.tipB')
                      : t('ab.tipIdle')
                }
              >
                {abUi.state === 'loop' && abUi.a != null && abUi.b != null
                  ? `AB ${formatClock(abUi.a)}-${formatClock(abUi.b)}`
                  : t('ab.button')}
              </Button>
              <Select
                value={loopMode}
                onValueChange={(v) => setLoopMode(v as LoopMode)}
              >
                <SelectTrigger
                  className="h-7 w-[96px] text-xs"
                  aria-label={t('loop.label')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOOP_OPTIONS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m === 'inf'
                        ? t('loop.inf')
                        : t('loop.n', { n: parseInt(m, 10) })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="flex-1" />
              <span className="text-[11px] text-muted-foreground">
                {t('speed')} · {rate.toFixed(2)}x
              </span>
              <Select
                value={String(rate)}
                onValueChange={(v) => setRate(parseFloat(v))}
              >
                <SelectTrigger
                  className="h-7 w-[72px] text-xs"
                  aria-label={t('speed')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RATE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={String(r)}>
                      {r}x
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-7 w-7',
                  showWave ? 'text-primary' : 'text-muted-foreground',
                )}
                onClick={() => setShowWave((v) => !v)}
                title={t('toggleWave')}
                aria-label={t('toggleWave')}
              >
                <AudioLines className="h-4 w-4" />
              </Button>
              {!isAudioMedia && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={
                    isFullscreen ? t('exitFullscreen') : t('fullscreen')
                  }
                  title={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
                  onClick={toggleFullscreen}
                >
                  {isFullscreen ? (
                    <Minimize2 className="h-4 w-4" />
                  ) : (
                    <Maximize2 className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
          </div>

          {/* 字幕面板宽度拖拽条 + 右侧字幕列表（可隐藏） */}
          {showList && (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startListResize}
                title={t('list.resizeHint')}
                className="w-1 flex-shrink-0 cursor-col-resize self-stretch rounded bg-transparent transition-colors hover:bg-primary/30 active:bg-primary/50"
              />
              <div
                style={{ width: listWidth }}
                className="flex min-h-0 flex-shrink-0 flex-col pl-2"
              >
                <Tabs
                  value={panelTab}
                  onValueChange={(v) =>
                    setPanelTab(
                      v as 'subtitles' | 'library' | 'playlists' | 'favorites',
                    )
                  }
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <TabsList className="mb-1.5 h-7 w-full flex-shrink-0 p-0.5">
                    <TabsTrigger
                      value="subtitles"
                      className="h-6 flex-1 px-1 text-xs"
                    >
                      {t('tabs.subtitles')}
                    </TabsTrigger>
                    <TabsTrigger
                      value="library"
                      className="h-6 flex-1 px-1 text-xs"
                    >
                      {t('tabs.library')}
                    </TabsTrigger>
                    <TabsTrigger
                      value="playlists"
                      className="h-6 flex-1 px-1 text-xs"
                    >
                      {t('tabs.playlists')}
                    </TabsTrigger>
                    <TabsTrigger
                      value="favorites"
                      className="h-6 flex-1 px-1 text-xs"
                    >
                      {t('fav.title')}
                    </TabsTrigger>
                  </TabsList>
                  {/* 内容区手动条件渲染（不经 radix TabsContent）：保证各标签页撑满可视空间 */}
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {panelTab === 'subtitles' && (
                      <>
                        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                          <Checkbox
                            checked={
                              cues.length > 0 && selection.size === cues.length
                            }
                            onCheckedChange={(checked) => {
                              if (checked === true)
                                setSelection(new Set(cues.map((_, i) => i)));
                              else setSelection(new Set());
                            }}
                            aria-label={t('list.selectAll')}
                            className="ml-1"
                          />
                          <span className="text-[11px] text-muted-foreground">
                            {t('list.selectAll')}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-[11px]"
                            onClick={() => setSelection(new Set())}
                          >
                            {t('list.clear')}
                          </Button>
                          <span className="text-[11px] text-muted-foreground tnum">
                            {t('list.selected', { n: selection.size })}
                          </span>
                          <span className="flex items-center gap-1">
                            <Checkbox
                              checked={singleRepeat}
                              onCheckedChange={(checked) => {
                                const on = checked === true;
                                setSingleRepeat(on);
                                if (on) {
                                  stopQueue();
                                  stopAb();
                                  anchorSingleRepeatCue(
                                    videoRef.current?.currentTime ?? 0,
                                  );
                                } else {
                                  singleRepeatCueRef.current = null;
                                }
                              }}
                              aria-label={t('list.singleRepeat')}
                            />
                            <span className="text-[11px] text-muted-foreground">
                              {t('list.singleRepeat')}
                            </span>
                          </span>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 gap-1 px-1.5 text-[11px]"
                              >
                                <Tags className="h-3.5 w-3.5" />
                                {t('group.button')}
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              <DropdownMenuLabel>
                                {t('group.auto')}
                              </DropdownMenuLabel>
                              <DropdownMenuItem onClick={applySpeakerGroups}>
                                <User className="mr-2 h-3.5 w-3.5" />
                                {t('group.bySpeaker')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={applyParagraphGroups}>
                                <Pilcrow className="mr-2 h-3.5 w-3.5" />
                                {t('group.byParagraph')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuLabel>
                                {t('group.manual')}
                              </DropdownMenuLabel>
                              <DropdownMenuItem onClick={mergeSelectionToGroup}>
                                <Combine className="mr-2 h-3.5 w-3.5" />
                                {t('group.mergeSelected')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={removeSelectionFromGroups}
                              >
                                <Eraser className="mr-2 h-3.5 w-3.5" />
                                {t('group.removeSelected')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setCueGroups({})}
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                {t('group.clear')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={openGroupManager}>
                                <Settings2 className="mr-2 h-3.5 w-3.5" />
                                {t('group.manage')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuLabel>
                                {t('edit.section')}
                              </DropdownMenuLabel>
                              <DropdownMenuItem
                                onClick={() => mergeCues(Array.from(selection))}
                              >
                                <Combine className="mr-2 h-3.5 w-3.5" />
                                {t('edit.mergeSelected', { n: selection.size })}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <span className="flex-1" />
                          <Button
                            variant="ghost"
                            size="icon"
                            className={cn(
                              'h-6 w-6',
                              searchOpen
                                ? 'text-primary'
                                : 'text-muted-foreground',
                            )}
                            onClick={() => setSearchOpen((v) => !v)}
                            aria-label={t('list.search')}
                            title={t('list.search')}
                          >
                            <Search className="h-3.5 w-3.5" />
                          </Button>
                          <span className="flex items-center gap-1">
                            <Checkbox
                              checked={queueUi.active}
                              disabled={!cues.length}
                              onCheckedChange={(checked) => {
                                if (checked === true)
                                  startSelectionPlayback(selection);
                                else stopQueue();
                              }}
                              aria-label={t('list.playSelection')}
                            />
                            <span className="text-[11px] text-muted-foreground">
                              {t('list.playSelection')}
                            </span>
                          </span>
                          {queueUi.active && (
                            <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                              <span className="tnum">
                                {t('list.queueInfo', {
                                  pass: queueUi.pass,
                                  pos: queueUi.pos + 1,
                                  total: queueUi.total,
                                  max:
                                    queueUi.maxPass === Infinity
                                      ? '∞'
                                      : String(queueUi.maxPass),
                                })}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-6 px-1.5 text-[11px]"
                                onClick={stopQueue}
                              >
                                {t('list.stop')}
                              </Button>
                            </span>
                          )}
                        </div>
                        {cues.length ? (
                          <>
                            {searchOpen && (
                              <div className="mb-1.5 space-y-1.5 rounded-md border border-border bg-muted/40 p-1.5">
                                <div className="flex items-center gap-1.5">
                                  <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                                  <Input
                                    className="h-7 flex-1 text-xs"
                                    placeholder={t('list.searchPlaceholder')}
                                    value={searchQuery}
                                    onChange={(e) => {
                                      setSearchQuery(e.target.value);
                                      setMatchIndex(0);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter')
                                        gotoMatch(e.shiftKey ? -1 : 1);
                                      else if (e.key === 'Escape')
                                        setSearchOpen(false);
                                    }}
                                  />
                                  <span className="whitespace-nowrap text-[11px] text-muted-foreground tnum">
                                    {searchMatches.length
                                      ? `${(matchIndex % searchMatches.length) + 1}/${searchMatches.length}`
                                      : searchQuery
                                        ? '0/0'
                                        : ''}
                                  </span>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    disabled={!searchMatches.length}
                                    onClick={() => gotoMatch(-1)}
                                    aria-label={t('list.prevMatch')}
                                  >
                                    <ChevronUp className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    disabled={!searchMatches.length}
                                    onClick={() => gotoMatch(1)}
                                    aria-label={t('list.nextMatch')}
                                  >
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground"
                                    onClick={() => {
                                      setSearchOpen(false);
                                      setSearchQuery('');
                                    }}
                                    aria-label={t('list.closeSearch')}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Input
                                    className="h-7 flex-1 text-xs"
                                    placeholder={t('list.replacePlaceholder')}
                                    value={replaceQuery}
                                    onChange={(e) =>
                                      setReplaceQuery(e.target.value)
                                    }
                                  />
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-[11px]"
                                    disabled={!activeMatchId}
                                    onClick={replaceCurrentMatch}
                                  >
                                    {t('list.replace')}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-[11px]"
                                    disabled={!searchMatches.length}
                                    onClick={replaceAllMatches}
                                  >
                                    {t('list.replaceAll')}
                                  </Button>
                                </div>
                              </div>
                            )}
                            <p className="mb-1 text-[11px] text-muted-foreground">
                              {t('list.dragHint')}
                            </p>
                            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                              <RepeatSubtitleList
                                cues={cues}
                                activeIndex={activeCueIndex}
                                queueIndex={
                                  queueUi.active && queueUi.pos >= 0
                                    ? (queueRef.current.list[queueUi.pos]
                                        ?.idx ?? -1)
                                    : -1
                                }
                                selection={selection}
                                onSelectionChange={handleSelectionChange}
                                onRowContextMenu={openCueContextMenu}
                                groups={cueGroups}
                                searchQuery={searchQuery}
                                activeMatchId={activeMatchId}
                                singleRepeatActive={singleRepeat}
                                onActivate={activateCue}
                                onEdit={(i, patch) => {
                                  setCues((prev) => {
                                    const next = [...prev];
                                    const cue = { ...next[i] };
                                    if (patch.text != null)
                                      cue.text = patch.text;
                                    if (patch.start != null)
                                      cue.start = patch.start;
                                    if (patch.end != null)
                                      cue.end = Math.max(
                                        patch.end,
                                        cue.start + 0.1,
                                      );
                                    next[i] = cue;
                                    return next;
                                  });
                                  setDirty(true);
                                }}
                              />
                            </div>
                          </>
                        ) : (
                          <EmptyState
                            icon={Captions}
                            title={t('list.empty')}
                            description={t('list.emptyDesc')}
                            className="flex-1 justify-center"
                          />
                        )}
                      </>
                    )}
                    {panelTab === 'library' && (
                      <MediaLibraryPanel ctx={mediaCtx} />
                    )}
                    {panelTab === 'playlists' && (
                      <PlaylistPanel
                        ctx={mediaCtx}
                        playMode={mediaPlayMode}
                        onPlayModeChange={setMediaPlayMode}
                        onPlayQueue={playMediaQueue}
                        queueInfo={mediaQueueUi}
                        onStopQueue={stopMediaQueue}
                      />
                    )}
                    {panelTab === 'favorites' && (
                      <FavoriteCuesPanel
                        favorites={favorites}
                        setFavorites={setFavorites}
                        favGroups={favGroups}
                        setFavGroups={setFavGroups}
                        currentKey={
                          cues[activeCueIndex]
                            ? `${subtitlePath}@${cues[activeCueIndex].start.toFixed(2)}`
                            : null
                        }
                        onLocate={playFavorite}
                      />
                    )}
                  </div>
                </Tabs>
              </div>
            </>
          )}
        </div>
      </div>
      {homeMenuElement}

      {/* 字幕句归入分组选择器 */}
      <Dialog
        open={cueGroupPicker != null}
        onOpenChange={(o) => !o && setCueGroupPicker(null)}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-base">
              {t('group.assignPicker')}
            </DialogTitle>
          </DialogHeader>
          {cueGroupPicker != null && cueGroups[cues[cueGroupPicker]?.id] && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-destructive hover:bg-accent"
              onClick={() => {
                assignCueToGroup(cueGroupPicker, null, '');
                setCueGroupPicker(null);
              }}
            >
              {t('group.removeFromGroup')}
            </button>
          )}
          <div className="max-h-52 space-y-0.5 overflow-y-auto">
            {uniqueCueGroups.map((g) => (
              <button
                key={g.index}
                type="button"
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                onClick={() => {
                  assignCueToGroup(cueGroupPicker as number, g, g.label);
                  setCueGroupPicker(null);
                }}
              >
                <span
                  className="h-3 w-[3px] flex-shrink-0 rounded-full"
                  style={{ backgroundColor: g.color }}
                />
                <span className="truncate">{g.label}</span>
              </button>
            ))}
            {!uniqueCueGroups.length && (
              <p className="py-2 text-center text-xs text-muted-foreground">
                {t('group.noneYet')}
              </p>
            )}
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => {
              setCueGroupPicker(null);
              openGroupManager();
            }}
          >
            <Settings2 className="h-3 w-3" />
            {t('group.manage')}
          </button>
          <div className="flex gap-1.5">
            <Input
              className="h-7 flex-1 text-xs"
              placeholder={t('group.newPlaceholder')}
              value={pickerNewName}
              onChange={(e) => setPickerNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  createAndAssignCueGroup(cueGroupPicker as number);
              }}
            />
            <Button
              size="sm"
              className="h-7"
              disabled={!pickerNewName.trim()}
              onClick={() => createAndAssignCueGroup(cueGroupPicker as number)}
            >
              {t('group.createAndAssign')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {/* 分组管理对话框：改名 / 调序 / 删组 */}
      <Dialog open={groupManagerOpen} onOpenChange={setGroupManagerOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{t('group.manage')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {managerRows.map((row, i) => (
              <div
                key={row.index}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5',
                  row.deleted && 'opacity-40',
                )}
              >
                <span
                  className="h-4 w-[3px] flex-shrink-0 rounded-full"
                  style={{ backgroundColor: row.color }}
                />
                <Input
                  className="h-6 min-w-0 flex-1 text-xs"
                  value={row.label}
                  onChange={(e) =>
                    setManagerRows((prev) =>
                      prev.map((r, j) =>
                        j === i ? { ...r, label: e.target.value } : r,
                      ),
                    )
                  }
                />
                <span className="flex-shrink-0 text-[10.5px] text-faint tnum">
                  #{i + 1}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={i === 0}
                  onClick={() => moveManagerRow(i, -1)}
                  aria-label={t('group.moveUp')}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={i === managerRows.length - 1}
                  onClick={() => moveManagerRow(i, 1)}
                  aria-label={t('group.moveDown')}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-6 w-6',
                    row.deleted
                      ? 'text-primary'
                      : 'text-destructive hover:text-destructive',
                  )}
                  onClick={() =>
                    setManagerRows((prev) =>
                      prev.map((r, j) =>
                        j === i ? { ...r, deleted: !r.deleted } : r,
                      ),
                    )
                  }
                  title={t('group.rowDelete')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {!managerRows.length && (
              <p className="py-2 text-center text-xs text-muted-foreground">
                {t('group.noneYet')}
              </p>
            )}
          </div>
          <DialogFooter className="gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setGroupManagerOpen(false)}
            >
              {t('list.cancel')}
            </Button>
            <Button size="sm" onClick={applyGroupEdits}>
              {t('group.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 字幕句分拆对话框 */}
      <Dialog
        open={splitIndex != null}
        onOpenChange={(o) => !o && setSplitIndex(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">
              {t('edit.splitTitle')}
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t('edit.splitHint')}</p>
          <Textarea
            ref={splitTextRef}
            rows={4}
            className="min-h-0 text-[12.5px]"
            value={splitText}
            onChange={(e) => setSplitText(e.target.value)}
          />
          <DialogFooter className="gap-1.5">
            <Button variant="outline" size="sm" onClick={splitByLines}>
              <Scissors className="h-3.5 w-3.5" />
              {t('edit.splitByLines')}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                splitAtCaret(splitTextRef.current?.selectionStart ?? 0)
              }
            >
              <Scissors className="h-3.5 w-3.5" />
              {t('edit.splitAtCaret')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSplitIndex(null)}
            >
              {t('list.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {dragOverlay}
    </div>
  );
}
