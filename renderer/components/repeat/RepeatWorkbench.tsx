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
  Camera,
  Captions,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Combine,
  Eraser,
  FileText,
  Folder,
  Gauge,
  Pilcrow,
  ListVideo,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRight,
  Pause,
  Play,
  Plus,
  Repeat,
  Save,
  Scissors,
  Search,
  Settings2,
  SlidersHorizontal,
  Tags,
  User,
  SkipBack,
  SkipForward,
  Square,
  Star,
  Trash2,
  Gamepad2,
  Video,
  WrapText,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/EmptyState';
import { useHotkeys } from 'hooks/useHotkeys';
import SubtitlePreviewOverlay from '@/components/subtitleMerge/SubtitlePreviewOverlay';
import InteractiveSubtitleOverlay from './InteractiveSubtitleOverlay';
import ShadowRecordingOverlay from './ShadowRecordingOverlay';
import RemoteMapDialog, { type RemoteActionDef } from './RemoteMapDialog';
import {
  LIBASS_SRT_PLAYRES_Y,
  subtitleStyleToCSS,
} from '@/components/subtitleMerge/utils/styleUtils';
import {
  getDefaultStyle,
  STYLE_PRESETS,
} from '@/components/subtitleMerge/constants';
import BasicStyleSettings from '@/components/subtitleMerge/BasicStyleSettings';
import AdvancedStyleSettings from '@/components/subtitleMerge/AdvancedStyleSettings';
import StylePresets from '@/components/subtitleMerge/StylePresets';
import AlignmentSelector from '@/components/subtitleMerge/AlignmentSelector';
import EffectStyleSettings from '@/components/subtitleMerge/EffectStyleSettings';
import {
  FONT_LIST,
  FONT_SIZE_RANGE,
} from '@/components/subtitleMerge/constants';
import type { SubtitleStyle } from '../../../types/subtitleMerge';
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
import { PromptDialog, MediaPropertiesDialog } from './dialogs';
import { repeatPlaybackBus } from './playbackBus';
import {
  addMediaEntry,
  addMediaToPlaylist,
  favoriteMedia,
  findCategory,
  kindOf,
  pushRecent,
  removeRecent,
  useRepeatStore,
  type MediaNameMode,
  type PlaylistData,
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

const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** 手柄变速键的循环档位（顺序循环，不含 3x） */
const SPEED_CYCLE = [0.5, 0.75, 1, 1.25, 1.5, 2];
const LOOP_OPTIONS = ['inf', '1', '2', '3', '5', '10'] as const;
type LoopMode = (typeof LOOP_OPTIONS)[number];

/** 拖拽/自动配对时识别的字幕扩展名（srt 优先） */
const SUBTITLE_EXTS = ['srt', 'vtt', 'ass', 'ssa', 'lrc'];

const REPEAT_CFG_KEY = 'repeatPlaybackCfg';

/**
 * 蓝牙复读手柄（HID 媒体键）的默认映射：键为 useHotkeys 组合格式（小写）。
 * BHA01 等手柄配对后发媒体键/键盘键，用户可在「手柄按键映射」对话框重绑。
 */
const DEFAULT_REMOTE_MAP: Record<string, string> = {
  mediaplaypause: 'playPause',
  mediatrackprevious: 'prevCue',
  mediatracknext: 'nextCue',
  mediarewind: 'frameBack',
  mediafastforward: 'frameFwd',
  mediastop: 'stop',
};

/** 已登记的蓝牙遥控设备（连接记录持久化；nameFilter 为广播名匹配关键字） */
export interface RemoteDeviceDef {
  id: string;
  label: string;
  nameFilter: string;
  /** 按键事件特征值 UUID 片段（BHA 系为 fb01；其它私有协议手柄按实际填写） */
  charFragment: string;
  addedAt: number;
  lastConnectedAt?: number;
}

const DEFAULT_REMOTE_DEVICES: RemoteDeviceDef[] = [
  {
    id: 'bha02',
    label: 'Yimanxin BHA02',
    nameFilter: 'BHA',
    charFragment: 'fb01',
    addedAt: 0,
  },
];

function loadPersistedCfg(): {
  rate?: number;
  loopMode?: LoopMode;
  showWave?: boolean;
  showList?: boolean;
  listWidth?: number;
  singleRepeat?: boolean;
  showTransport?: boolean;
  showSubtitle?: boolean;
  repeatGap?: number;
  subtitleStyle?: SubtitleStyle;
  nameMode?: MediaNameMode;
  remoteMap?: Record<string, string>;
  bleMap?: Record<string, string>;
  remoteDevices?: RemoteDeviceDef[];
  activeDeviceId?: string;
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
  // 起始页（未载入媒体）默认停在「媒体库」，便于直接点击播放；载入媒体后切回「字幕」
  const [panelTab, setPanelTab] = useState<
    'subtitles' | 'library' | 'playlists' | 'favorites'
  >('library');
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
  const [newGroupTargets, setNewGroupTargets] = useState<number[] | null>(null);
  const [favGroupFilter, setFavGroupFilter] = useState<string>('all');
  // 媒体库面板当前选中的分类（收藏当前媒体/拖拽导入的目标）
  const [libSelectedCatId, setLibSelectedCatId] = useState<string | null>(null);
  const [propertiesPath, setPropertiesPath] = useState<string | null>(null);
  // 循环播放间隔（秒）：单句重复/AB/队列每次循环到尾后暂停该时长再继续
  const [repeatGap, setRepeatGap] = useState<number>(
    () => loadPersistedCfg().repeatGap ?? 0,
  );
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
  // 视频画面：显示/隐藏 播放控制栏 与 视频内嵌字幕
  const [showTransport, setShowTransport] = useState(
    () => loadPersistedCfg().showTransport !== false,
  );
  const [showSubtitle, setShowSubtitle] = useState(
    () => loadPersistedCfg().showSubtitle !== false,
  );
  // 媒体库/播放列表文件名显示模式（自定义名称/文件名/标签标题/专辑名）
  const [nameMode, setNameMode] = useState<MediaNameMode>(
    () => loadPersistedCfg().nameMode ?? 'custom',
  );
  // 手柄/遥控按键映射（默认覆盖常见媒体键，可在映射对话框重绑）
  const [remoteMap, setRemoteMap] = useState<Record<string, string>>(() => ({
    ...DEFAULT_REMOTE_MAP,
    ...loadPersistedCfg().remoteMap,
  }));
  const [remoteMapOpen, setRemoteMapOpen] = useState(false);
  // 蓝牙手柄 BLE 直连：键码(如 '21') -> 动作 id；桥接状态
  const [bleMap, setBleMap] = useState<Record<string, string>>(
    () => loadPersistedCfg().bleMap || {},
  );
  const [bleStatus, setBleStatus] = useState('off');
  // 蓝牙遥控设备记录与当前激活设备（连接别的手柄：登记 nameFilter + 按键通道片段）
  const [remoteDevices, setRemoteDevices] = useState<RemoteDeviceDef[]>(
    () => loadPersistedCfg().remoteDevices || DEFAULT_REMOTE_DEVICES,
  );
  const [activeDeviceId, setActiveDeviceId] = useState(
    () => loadPersistedCfg().activeDeviceId || 'bha02',
  );

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
          showTransport,
          showSubtitle,
          repeatGap,
          subtitleStyle,
          nameMode,
          remoteMap,
          bleMap,
          remoteDevices,
          activeDeviceId,
        }),
      );
    } catch {
      /* 忽略 */
    }
  }, [
    rate,
    loopMode,
    showWave,
    showList,
    listWidth,
    singleRepeat,
    showTransport,
    showSubtitle,
    repeatGap,
    nameMode,
    remoteMap,
    bleMap,
    remoteDevices,
    activeDeviceId,
  ]);

  // 全屏状态同步（Esc 退出时复位按钮态）
  useEffect(() => {
    const onFsChange = () =>
      setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // 视频容器尺寸变化（字幕 overlay 的定位与字号缩放依赖）
  const [videoBoxH, setVideoBoxH] = useState(0);
  // 视频画面字幕样式（当前为合成页默认样式；后续接合成页样式设置时可替换）
  const [styleDialogOpen, setStyleDialogOpen] = useState(false);
  const [stylePanelPos, setStylePanelPos] = useState({ x: 0, y: 0 });
  const [stylePanelSize, setStylePanelSize] = useState({ w: 300, h: 420 });
  const stylePanelRef = useRef<HTMLDivElement>(null);

  const startStylePanelResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = stylePanelSize.w;
    const startH = stylePanelSize.h;
    const move = (ev: PointerEvent) => {
      setStylePanelSize({
        w: Math.max(240, startW + (ev.clientX - startX)),
        h: Math.max(280, startH + (ev.clientY - startY)),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 标题栏拖拽移动面板 */
  const startStylePanelDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = { ...stylePanelPos };
    const move = (ev: PointerEvent) => {
      setStylePanelPos({
        x: Math.max(0, startPos.x + (ev.clientX - startX)),
        y: Math.max(0, startPos.y + (ev.clientY - startY)),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(() => {
    const saved = loadPersistedCfg().subtitleStyle;
    return saved ? { ...getDefaultStyle(), ...saved } : getDefaultStyle();
  });
  const videoBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = videoBoxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setVideoBoxH(el.clientHeight));
    ro.observe(el);
    setVideoBoxH(el.clientHeight);
    return () => ro.disconnect();
  }, [videoPath]);

  // 视频画面右键菜单 + 帧步进 + 截图
  const FRAME_STEP_SEC = 1 / 30;
  const GAP_OPTIONS = [0, 0.5, 1, 1.5, 2, 3];

  /** 上一帧 / 下一帧：暂停后按 1/30 秒步进（engineSeek 防护避免引擎抢跳） */
  const stepFrame = (dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v || !videoPath || isAudioMedia) return;
    v.pause();
    engineSeek(
      clamp(v.currentTime + dir * FRAME_STEP_SEC, 0, duration || v.currentTime),
    );
    setCurrentTime(v.currentTime);
  };

  /** 截取当前视频帧为 PNG 并下载到本地下载目录 */
  const captureFrame = () => {
    const v = videoRef.current as HTMLVideoElement | null;
    if (!v || !v.videoWidth) {
      toast.warning(t('shot.fail'));
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) {
          toast.error(t('shot.fail'));
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${basename(videoPath).replace(
          /\.[^.]+$/,
          '',
        )}_${formatClock(v.currentTime).replace(/:/g, '')}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast.success(t('shot.saved'));
      }, 'image/png');
    } catch {
      toast.error(t('shot.fail'));
    }
  };

  const { openMenu: openVideoMenuRaw, menuElement: videoMenuElement } =
    useContextMenu();

  const openVideoMenu = (e: React.MouseEvent) => {
    if (isAudioMedia) return;
    openVideoMenuRaw(e, [
      {
        key: 'transport',
        label: showTransport
          ? t('vmenu.hideTransport')
          : t('vmenu.showTransport'),
        icon: SlidersHorizontal,
        onSelect: () => setShowTransport((v) => !v),
      },
      {
        key: 'subtitle',
        label: showSubtitle ? t('vmenu.hideSubtitle') : t('vmenu.showSubtitle'),
        icon: Captions,
        onSelect: () => setShowSubtitle((v) => !v),
      },
      {
        key: 'style',
        label: t('vmenu.subtitleStyle'),
        icon: Settings2,
        onSelect: () => {
          setStylePanelPos({ x: Math.max(20, window.innerWidth - 340), y: 80 });
          setStyleDialogOpen(true);
        },
      },
      {
        key: 'speed',
        label: t('vmenu.speed'),
        icon: Gauge,
        children: RATE_OPTIONS.map((r) => ({
          key: `speed-${r}`,
          label: `${r}x${r === rate ? ' ✓' : ''}`,
          onSelect: () => setRate(r),
        })),
      },
      {
        key: 'playControl',
        label: t('vmenu.playControl'),
        icon: Play,
        children: [
          {
            key: 'frame-prev',
            label: t('vmenu.prevFrame'),
            icon: ChevronLeft,
            onSelect: () => stepFrame(-1),
          },
          {
            key: 'frame-next',
            label: t('vmenu.nextFrame'),
            icon: ChevronRight,
            onSelect: () => stepFrame(1),
          },
          {
            key: 'remote-map',
            label: t('remote.map'),
            icon: Gamepad2,
            onSelect: () => setTimeout(() => setRemoteMapOpen(true), 0),
          },
        ],
      },
      {
        key: 'screenshot',
        label: t('vmenu.screenshot'),
        icon: Camera,
        onSelect: captureFrame,
      },
      {
        key: 'properties',
        label: t('prop.menuItem'),
        icon: FileText,
        onSelect: () => setPropertiesPath(videoPath),
      },
    ]);
  };

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
    setPanelTab('subtitles');
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
    // 自动加入媒体库与默认播放列表
    setLibrary((prev) => {
      const { data } = addMediaEntry(prev, path);
      const mediaId = Object.values(data.media).find(
        (m) => m.path === path,
      )?.id;
      if (mediaId) {
        // 确保存在默认播放列表并把媒体加入
        setPlaylists((pls) => {
          let def = pls.find((p) => p.id === '__default__');
          if (!def) {
            def = {
              id: '__default__',
              name: t('playlist.defaultName'),
              mediaIds: [],
              createdAt: Date.now(),
            };
            return [...pls, def];
          }
          return pls;
        });
        // 需要在 playlists 状态也更新后加入，用回调嵌套确保拿到最新值
        setTimeout(() => {
          setPlaylists((pls) => {
            if (!pls.find((p) => p.id === '__default__')) {
              const def: PlaylistData = {
                id: '__default__',
                name: t('playlist.defaultName'),
                mediaIds: [mediaId],
                createdAt: Date.now(),
              };
              return [...pls, def];
            }
            return addMediaToPlaylist(pls, '__default__', mediaId);
          });
        }, 0);
      }
      return data;
    });
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
      // 打包环境页面源为 app://-，fetch('media://…') 跨协议被拒 → 统一经 IPC 读字节
      const res = await window?.ipc?.invoke('mediaFile:readBuffer', {
        filePath: path,
      });
      if (!res?.success || !res.data) {
        throw new Error(res?.error || 'read audio file failed');
      }
      const bytes = new Uint8Array(res.data);
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ac = new AC();
      const audio = await ac.decodeAudioData(arrayBuffer);
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

  /** 蓝牙面板「播放上次内容」：直接续播最近一次播放的媒体 */
  const playLastMedia = () => {
    const last = recents[0];
    if (last) playRecent(last);
  };

  const favoriteCurrent = () => {
    if (!videoPath) return;
    setLibrary(favoriteMedia(library, videoPath, libSelectedCatId).data);
    const label = libSelectedCatId
      ? findCategory(library.categories, libSelectedCatId)?.name ||
        t('library.unfiled')
      : t('library.unfiled');
    toast.success(t('fav.assigned', { label }));
    setPanelTab('library');
  };

  const mediaCtx: RepeatMediaContext = {
    library,
    setLibrary,
    playlists,
    setPlaylists,
    currentMediaPath: videoPath || null,
    onPlayMedia: playSingleMedia,
    onShowProperties: setPropertiesPath,
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
    cueIndex: number | number[],
    group: CueGroup | null,
    label: string,
  ) => {
    const indices = Array.isArray(cueIndex) ? cueIndex : [cueIndex];
    setCueGroups((prev) => {
      const next = { ...prev };
      indices.forEach((i) => {
        const id = cues[i]?.id;
        if (!id) return;
        if (group) next[id] = group;
        else delete next[id];
      });
      return next;
    });
    if (group) {
      toast.success(
        indices.length > 1
          ? t('group.assignedMulti', { label, n: indices.length })
          : t('group.assigned', { label }),
      );
    }
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

  /** 新建组并把所选句都归入 */
  const createGroupAndAssign = (name: string) => {
    if (!name || !newGroupTargets?.length) return;
    const index =
      Object.values(cueGroups).reduce((m, g) => Math.max(m, g.index), 0) + 1;
    assignCueToGroup(
      newGroupTargets,
      {
        index,
        label: name,
        color: GROUP_COLORS[(index - 1) % GROUP_COLORS.length],
      },
      name,
    );
    setNewGroupTargets(null);
  };

  const favoriteCues = (indices: number[]) => {
    if (!cues.length || !indices.length) return;
    if (!subtitlePath) {
      toast.warning(t('fav.noSource'));
      return;
    }
    // 收藏标签页正按分组筛选时，新收藏自动归入当前筛选的分组
    const targetGroupId =
      panelTab === 'favorites' &&
      favGroupFilter !== 'all' &&
      favGroupFilter !== 'none'
        ? favGroupFilter
        : null;
    const fresh: FavoriteCue[] = [];
    indices.forEach((i) => {
      const cue = cues[i];
      if (!cue) return;
      if (
        favorites.some(
          (f) =>
            f.sourceSubtitle === subtitlePath &&
            Math.abs(f.start - cue.start) < 0.01,
        )
      )
        return;
      fresh.push({
        id: `fc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${i}`,
        text: cue.text,
        sourceSubtitle: subtitlePath,
        videoPath,
        start: cue.start,
        end: cue.end,
        createdAt: Date.now(),
        groupId: targetGroupId,
      });
    });
    if (!fresh.length) {
      toast.info(t('fav.exists'));
      return;
    }
    setFavorites((prev) => [...fresh, ...prev]);
    toast.success(
      fresh.length > 1
        ? t('fav.addedMulti', { n: fresh.length })
        : t('fav.added'),
    );
  };

  /** 播放指定分组：该组全部句子按序设为勾选并启动勾选队列复读 */
  const playCueGroup = (g: CueGroup) => {
    const idxs = cues
      .map((c, idx) => (cueGroups[c.id]?.index === g.index ? idx : -1))
      .filter((idx) => idx >= 0);
    if (!idxs.length) return;
    // 单句复读优先级最高，会抢占队列，先关闭
    if (singleRepeatRef.current) setSingleRepeat(false);
    const sel = new Set(idxs);
    setSelection(sel);
    startSelectionPlayback(sel);
    toast.success(t('group.playingGroup', { label: g.label }));
  };

  /** 字幕行右键菜单 */
  const openCueContextMenu = (e: React.MouseEvent, i: number) => {
    // 右键句在多选括选集内时：归入分组/收藏/移出分组作用于全部所选句
    const multi = selection.has(i) && selection.size > 1;
    const targets = multi ? Array.from(selection).sort((a, b) => a - b) : [i];
    const assignChildren: ContextMenuItemDef[] = [
      ...uniqueCueGroups.map((g) => ({
        key: `assign-${g.index}`,
        label: t('group.assignTo', { label: g.label }),
        icon: Folder,
        onSelect: () => assignCueToGroup(targets, g, g.label),
      })),
      { key: 'assign-sep', label: '', separator: true, onSelect: () => {} },
      {
        key: 'assign-new',
        label: t('group.newCueGroup'),
        icon: Plus,
        onSelect: () => setNewGroupTargets(targets),
      },
      {
        key: 'assign-manage',
        label: t('group.manage'),
        icon: Settings2,
        onSelect: () => openGroupManager(),
      },
    ];
    const anyGrouped = targets.some((idx) => cueGroups[cues[idx]?.id]);
    const playGroupChildren: ContextMenuItemDef[] = uniqueCueGroups.map(
      (g) => ({
        key: `playgroup-${g.index}`,
        label: t('group.playGroupItem', {
          label: g.label,
          n: cues.filter((c) => cueGroups[c.id]?.index === g.index).length,
        }),
        icon: Play,
        onSelect: () => playCueGroup(g),
      }),
    );
    const items: ContextMenuItemDef[] = [
      ...(anyGrouped
        ? [
            {
              key: 'ungroup',
              label: t('group.removeFromGroup'),
              icon: Eraser,
              danger: true,
              onSelect: () => assignCueToGroup(targets, null, ''),
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
        label: multi
          ? t('group.assignMulti', { n: targets.length })
          : t('group.assignSub'),
        icon: Folder,
        children: assignChildren,
      },
      ...(uniqueCueGroups.length
        ? [
            {
              key: 'playGroup',
              label: t('group.playGroup'),
              icon: Play,
              children: playGroupChildren,
            },
          ]
        : []),
      {
        key: 'fav',
        label:
          targets.length > 1
            ? t('fav.addMulti', { n: targets.length })
            : t('fav.add'),
        icon: Star,
        onSelect: () => favoriteCues(targets),
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
    const ph = shadowPhaseRef.current;
    if (ph === 'rec' || ph === 'gap') return; // 录音中/段间间隔：不响应
    if (ph === 'cmp-rec' || ph === 'post-rec') {
      // 对比/回放的录音段：空格暂停/继续录音本身
      const a = shadowAudioRef.current;
      if (a) {
        if (a.paused) void a.play().catch(() => {});
        else a.pause();
      }
      return;
    }
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
    if (gapTimerRef.current) {
      clearTimeout(gapTimerRef.current);
      gapTimerRef.current = null;
    }
    // 跟读/对比：停止循环与录音（录音保存但不自动回放）
    haltShadowPlayback();
    if (recorderRef.current || shadowPhaseRef.current === 'rec') {
      stopShadowRecording(false);
    }
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

  /**
   * 手柄按键微调 AB 点（AB 循环激活时有效）：
   * A 点 ±0.5s 后从新 A 点重新开始循环播放；B 点 ±0.5s 即时生效。
   */
  const adjustAbPoint = (which: 'a' | 'b', delta: number) => {
    const ab = abRef.current;
    const v = videoRef.current;
    if (ab.b == null) {
      toast.warning(t('toast.abNotSet'));
      return;
    }
    if (which === 'a') {
      const a =
        Math.round(clamp(ab.a + delta, 0, (ab.b ?? duration) - 0.3) * 10) / 10;
      abRef.current = { ...ab, a };
      syncAb();
      engineSeek(a + 0.001);
      if (v && v.paused) void v.play().catch(() => {});
    } else {
      const b =
        Math.round(
          clamp(ab.b + delta, (ab.a ?? 0) + 0.3, duration || ab.b + delta),
        ) / 10;
      abRef.current = { ...ab, b };
      syncAb();
    }
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
   * - 勾选只更新选择集，不自动播放（播放用工具栏「播放所选」/ 播放分组）；
   *   复读进行中勾选则把新段追加进队列；
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
  /** 按方向找目标句索引：>0 下一句起始，<0 上一句起始；无字幕返回 -1 */
  const findCueIndex = (delta: number): number => {
    if (!cues.length) return -1;
    if (delta > 0) {
      const t = cues.findIndex((c) => c.start > currentTime + 0.05);
      return t === -1 ? cues.length - 1 : t;
    }
    // ↑ = 上一句：先定位「当前所在句」（最后一个 start <= 当前时间的句），
    // 目标即其前一句；无论处在句中还是句首，↑ 都跳到上一句起点。
    let cur = -1;
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].start <= currentTime + 0.001) cur = i;
      else break;
    }
    return cur <= 0 ? 0 : cur - 1;
  };

  const jumpCue = (delta: number) => {
    const target = findCueIndex(delta);
    if (target >= 0) activateCue(target);
  };

  /**
   * 键盘 ↑/↓ 定位到上/下一句的起始时间点：
   * 跳转前在播放 → 继续播放；原本暂停 → 保持暂停。
   */
  const locateCue = (delta: number) => {
    const target = findCueIndex(delta);
    if (target < 0) return;
    const v = videoRef.current;
    const wasPlaying = !!v && !v.paused;
    stopAll();
    // 单句复读开启时跟随跳转到新句，避免引擎把进度拽回旧句
    if (singleRepeatRef.current) {
      singleRepeatCueRef.current = {
        start: cues[target].start,
        end: cues[target].end,
      };
    }
    engineSeek(cues[target].start + 0.001);
    setCurrentTime(cues[target].start + 0.001);
    if (wasPlaying && v) void v.play().catch(() => {});
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

  // 循环间隔等待：暂停 repeatGap 秒后从 target 位置继续
  const gapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gapPause = (target: number, cb?: () => void) => {
    const v = videoRef.current;
    if (!v || repeatGap <= 0) {
      engineSeek(target);
      if (v) void v.play().catch(() => {});
      return;
    }
    v.pause();
    gapTimerRef.current = setTimeout(() => {
      gapTimerRef.current = null;
      engineSeek(target);
      void v.play().catch(() => {});
    }, repeatGap * 1000);
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;

    // 单句重复：绝对优先，在 setCurrentTime 之前处理，
    // 避免越界时间值先传入 React 导致字幕高亮/overlay 闪跳到下一句
    if (singleRepeatRef.current) {
      if (!singleRepeatCueRef.current) anchorSingleRepeatCue(v.currentTime);
      const anchor = singleRepeatCueRef.current;
      if (
        anchor &&
        v.currentTime >= anchor.end - 0.02 &&
        !v.seeking &&
        !engineSeekGuardRef.current
      ) {
        if (repeatGap > 0) {
          v.pause();
          gapTimerRef.current = setTimeout(() => {
            engineSeek(anchor.start + 0.001);
            void v.play().catch(() => {});
          }, repeatGap * 1000);
          setCurrentTime(anchor.end);
        } else {
          // 无间隔：直接 seek 回句首，同步设置 React 状态保持一致
          v.currentTime = anchor.start + 0.001;
          setCurrentTime(anchor.start + 0.001);
        }
        if (v.duration && isFinite(v.duration)) setDuration(v.duration);
        return;
      }
      // 未到句尾（正常播放中）：更新 UI 但不进 AB/队列
      setCurrentTime(v.currentTime);
      if (v.duration && isFinite(v.duration)) setDuration(v.duration);
      return;
    }

    setCurrentTime(v.currentTime);
    if (v.duration && isFinite(v.duration)) setDuration(v.duration);
    if (v.seeking || engineSeekGuardRef.current) return;

    const ab = abRef.current;
    if (
      ab.state === 'loop' &&
      ab.a != null &&
      ab.b != null &&
      v.currentTime >= ab.b - 0.02
    ) {
      if (ab.repeats > 0) {
        ab.repeats -= 1;
        gapPause(ab.a);
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
        gapPause(q.list[nextPos].start + 0.001);
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
        gapPause(start + 0.001);
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
        gapPause(ab.a);
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
        gapPause(0);
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
  // ---------- 跟读录音 + 原声对比 ----------
  // 跟读键：播放当前句 → 句尾自动录音；录音超过「句长+3 秒」自动结束（再按可提前结束）
  //        → 自动回放录音 → 再播一遍原声后暂停；
  // 对比键：原声 ↔ 录音轮流循环播放，段间间隔=全局循环间隔（repeatGap），
  //        对比中可空格/点击暂停继续；再按对比键或停止键结束。
  type ShadowPhase =
    | 'idle'
    | 'orig' // 跟读：原句播放中
    | 'rec' // 录音中
    | 'post-rec' // 录后自动回放录音
    | 'post-orig' // 录后自动回放原句（播完暂停）
    | 'cmp-orig' // 对比循环：原句
    | 'cmp-rec' // 对比循环：录音
    | 'gap'; // 对比循环：段间间隔
  const [shadowPhase, setShadowPhase] = useState<ShadowPhase>('idle');
  const shadowPhaseRef = useRef<ShadowPhase>('idle');
  const setPhase = (ph: ShadowPhase) => {
    shadowPhaseRef.current = ph;
    setShadowPhase(ph);
  };
  const shadowCueRef = useRef<{ start: number; end: number } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStartRef = useRef(0);
  const recAutoSeqRef = useRef(true);
  const shadowUrlRef = useRef<string | null>(null);
  const shadowAudioRef = useRef<HTMLAudioElement | null>(null);
  const compareRef = useRef(false);
  const shadowTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gapUntilRef = useRef(0);
  const [recStream, setRecStream] = useState<MediaStream | null>(null);

  const stopShadowWatcher = () => {
    if (shadowTimerRef.current) {
      clearInterval(shadowTimerRef.current);
      shadowTimerRef.current = null;
    }
  };

  const playOrigSegment = (start: number, end: number) => {
    const v = videoRef.current;
    if (!v) return;
    shadowCueRef.current = { start, end };
    engineSeek(start + 0.001);
    void v.play().catch(() => {});
  };

  const playShadowRecording = (phase: ShadowPhase) => {
    if (!shadowUrlRef.current) {
      setPhase('idle');
      return;
    }
    if (!shadowAudioRef.current) {
      const a = new Audio(shadowUrlRef.current);
      a.onended = () => {
        if (shadowPhaseRef.current === 'post-rec') {
          // 录后序列：回放完录音 → 再播一遍原声 → 播完暂停
          const cue = shadowCueRef.current;
          if (cue) {
            playOrigSegment(cue.start, cue.end);
            setPhase('post-orig');
          } else {
            setPhase('idle');
          }
        } else if (compareRef.current) {
          // 对比循环：录音播完 → 间隔 repeatGap → 回到原句
          gapUntilRef.current = Date.now() + repeatGap * 1000;
          setPhase('gap');
        } else {
          setPhase('idle');
        }
      };
      shadowAudioRef.current = a;
    }
    const a = shadowAudioRef.current;
    a.currentTime = 0;
    void a.play().catch(() => {});
    setPhase(phase);
  };

  const startShadowRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      recChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) recChunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecStream(null);
        const blob = new Blob(recChunksRef.current, {
          type: rec.mimeType || 'audio/webm',
        });
        if (shadowUrlRef.current) URL.revokeObjectURL(shadowUrlRef.current);
        shadowUrlRef.current = URL.createObjectURL(blob);
        shadowAudioRef.current = null; // 下次回放按新录音重建
        toast.success(t('toast.shadowSaved'));
        if (recAutoSeqRef.current) playShadowRecording('post-rec');
        else setPhase('idle');
      };
      rec.start();
      recorderRef.current = rec;
      recStartRef.current = Date.now();
      setRecStream(stream);
      setPhase('rec');
      toast.info(t('toast.shadowRecording'));
    } catch (e) {
      toast.error(t('toast.micError', { err: String(e).slice(0, 90) }));
      setPhase('idle');
    }
  };

  /** autoSeq：结束后是否自动「回放录音→重播原声→暂停」 */
  const stopShadowRecording = (autoSeq = true) => {
    const rec = recorderRef.current;
    recorderRef.current = null;
    recAutoSeqRef.current = autoSeq;
    stopShadowWatcher();
    if (rec && rec.state !== 'inactive') rec.stop();
    else setPhase('idle');
  };

  const startShadowWatcher = () => {
    stopShadowWatcher();
    shadowTimerRef.current = setInterval(() => {
      const ph = shadowPhaseRef.current;
      const v = videoRef.current;
      const cue = shadowCueRef.current;
      if (ph === 'orig' || ph === 'post-orig' || ph === 'cmp-orig') {
        if (!v || !cue) return;
        // 仅按播放进度判定句尾：暂停=用户主动暂停，恢复后继续
        if (v.currentTime >= cue.end - 0.02) {
          v.pause();
          if (ph === 'orig') {
            void startShadowRecording();
          } else if (ph === 'post-orig') {
            setPhase('idle');
          } else {
            gapUntilRef.current = Date.now() + repeatGap * 1000;
            setPhase('gap');
          }
        }
      } else if (ph === 'rec') {
        // 录音时长超过「句长 + 3 秒」自动结束
        const limitSec = (cue ? cue.end - cue.start : 10) + 3;
        if (
          recorderRef.current &&
          Date.now() - recStartRef.current > limitSec * 1000
        ) {
          toast.info(t('toast.shadowAutoStop'));
          stopShadowRecording();
        }
      } else if (ph === 'gap') {
        if (Date.now() >= gapUntilRef.current) playShadowRecording('cmp-rec');
      }
    }, 80);
  };

  /** 停掉对比/回放类活动（不动录音状态） */
  const haltShadowPlayback = () => {
    compareRef.current = false;
    shadowAudioRef.current?.pause();
    stopShadowWatcher();
  };

  /** 手柄键：跟读录音（播原句→句尾自动录音→超时/手动结束→自动回放序列） */
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
    playOrigSegment(cues[i].start, Math.max(cues[i].end, cues[i].start + 0.3));
    setPhase('orig');
    startShadowWatcher();
    toast.info(t('toast.shadowStart'));
  };

  /** 手柄键：原声 ↔ 录音循环对比（段间按全局循环间隔；再按/停止键结束） */
  const toggleCompare = () => {
    if (compareRef.current) {
      haltShadowPlayback();
      setPhase('idle');
      return;
    }
    if (!shadowUrlRef.current) {
      toast.warning(t('toast.compareNeedRec'));
      return;
    }
    if (singleRepeatRef.current) setSingleRepeat(false);
    stopAll();
    const cue =
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
    }
    compareRef.current = true;
    playOrigSegment(cue.start, cue.end);
    setPhase('cmp-orig');
    startShadowWatcher();
    toast.info(t('toast.compareStart'));
  };

  // ---------- 手柄/遥控动作注册（映射对话框 + 快捷键共用） ----------
  const REMOTE_ACTIONS: RemoteActionDef[] = [
    { id: 'playPause', label: t('remote.aPlayPause'), run: () => togglePlay() },
    { id: 'prevCue', label: t('remote.aPrevCue'), run: () => locateCue(-1) },
    { id: 'nextCue', label: t('remote.aNextCue'), run: () => locateCue(1) },
    {
      id: 'frameBack',
      label: t('remote.aFrameBack'),
      run: () => stepFrame(-1),
    },
    { id: 'frameFwd', label: t('remote.aFrameFwd'), run: () => stepFrame(1) },
    {
      id: 'seekBack',
      label: t('remote.aSeekBack'),
      run: () => seekTo(currentTime - 5),
    },
    {
      id: 'seekFwd',
      label: t('remote.aSeekFwd'),
      run: () => seekTo(currentTime + 5),
    },
    { id: 'setA', label: t('remote.aSetA'), run: () => setPointA() },
    {
      id: 'setB',
      label: t('remote.aSetB'),
      run: () => (abRef.current.state === 'pickB' ? setPointB() : setPointA()),
    },
    {
      id: 'clearAB',
      label: t('remote.aClearAB'),
      run: () => {
        stopAb();
        toast.success(t('toast.abCleared'));
      },
    },
    {
      id: 'favorite',
      label: t('remote.aFavorite'),
      run: () => {
        if (activeCueIndex >= 0) favoriteCues([activeCueIndex]);
      },
    },
    {
      id: 'shadow',
      label: t('remote.aShadow'),
      run: () => toggleShadow(),
    },
    {
      id: 'compare',
      label: t('remote.aCompare'),
      run: () => toggleCompare(),
    },
    {
      id: 'aBack',
      label: t('remote.aABack'),
      run: () => adjustAbPoint('a', -0.5),
    },
    {
      id: 'aFwd',
      label: t('remote.aAFwd'),
      run: () => adjustAbPoint('a', 0.5),
    },
    {
      id: 'bBack',
      label: t('remote.aBBack'),
      run: () => adjustAbPoint('b', -0.5),
    },
    {
      id: 'bFwd',
      label: t('remote.aBFwd'),
      run: () => adjustAbPoint('b', 0.5),
    },
    {
      id: 'speedCycle',
      label: t('remote.aSpeedCycle'),
      run: () => {
        const idx = SPEED_CYCLE.indexOf(rate);
        const next = SPEED_CYCLE[(idx + 1) % SPEED_CYCLE.length];
        setRate(next);
        toast.info(t('toast.speedSet', { speed: next }));
      },
    },
    {
      id: 'speedUp',
      label: t('remote.aSpeedUp'),
      run: () =>
        setRate(
          RATE_OPTIONS[
            Math.min(RATE_OPTIONS.indexOf(rate) + 1, RATE_OPTIONS.length - 1)
          ],
        ),
    },
    {
      id: 'speedDown',
      label: t('remote.aSpeedDown'),
      run: () =>
        setRate(RATE_OPTIONS[Math.max(RATE_OPTIONS.indexOf(rate) - 1, 0)]),
    },
    {
      id: 'singleRepeat',
      label: t('remote.aSingleRepeat'),
      run: () => setSingleRepeat((v) => !v),
    },
    { id: 'stop', label: t('remote.aStop'), run: () => stopAll() },
    {
      id: 'screenshot',
      label: t('remote.aScreenshot'),
      run: () => captureFrame(),
    },
  ];

  // BLE 手柄事件用 ref 读最新映射/动作（事件回调挂载一次）
  const bleMapRef = useRef(bleMap);
  bleMapRef.current = bleMap;
  // BLE 手柄长按判定：按住的键码/动作/计时器（松开帧 '00' 无按键身份，记录最后按下的键）
  const bleHoldRef = useRef<{
    code: string;
    actionId: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const remoteActionsRef = useRef(REMOTE_ACTIONS);
  remoteActionsRef.current = REMOTE_ACTIONS;

  const activeDeviceIdRef = useRef(activeDeviceId);
  activeDeviceIdRef.current = activeDeviceId;

  const activeDevice =
    remoteDevices.find((d) => d.id === activeDeviceId) || remoteDevices[0];

  /** 切换/连接指定设备：停旧桥 → 按设备参数起新桥，并记录连接时间 */
  const useDevice = (d: RemoteDeviceDef) => {
    setActiveDeviceId(d.id);
    void window?.ipc
      ?.invoke('bleRemote:stop', {})
      .catch(() => {})
      .then(() =>
        window?.ipc?.invoke('bleRemote:start', {
          name: d.nameFilter,
          char: d.charFragment,
        }),
      );
    setRemoteDevices((prev) =>
      prev.map((x) =>
        x.id === d.id ? { ...x, lastConnectedAt: Date.now() } : x,
      ),
    );
  };

  /** 连接成功时回写设备的最后连接时间（记录） */
  const touchActiveDevice = () => {
    const id = activeDeviceIdRef.current;
    setRemoteDevices((prev) =>
      prev.map((x) =>
        x.id === id ? { ...x, lastConnectedAt: Date.now() } : x,
      ),
    );
  };

  const addDevice = (
    label: string,
    nameFilter: string,
    charFragment: string,
  ) => {
    const dev: RemoteDeviceDef = {
      id: 'dev-' + Date.now().toString(36),
      label,
      nameFilter,
      charFragment: charFragment || 'fb01',
      addedAt: Date.now(),
    };
    setRemoteDevices((prev) => [...prev, dev]);
    return dev;
  };

  const deleteDevice = (id: string) => {
    setRemoteDevices((prev) => {
      const next = prev.filter((d) => d.id !== id);
      return next.length ? next : DEFAULT_REMOTE_DEVICES;
    });
  };

  const toggleBleRemote = () => {
    if (bleStatus === 'off') {
      if (activeDevice) {
        void window?.ipc?.invoke('bleRemote:start', {
          name: activeDevice.nameFilter,
          char: activeDevice.charFragment,
        });
      }
    } else {
      void window?.ipc?.invoke('bleRemote:stop', {});
    }
  };

  // 顶栏蓝牙图标点击 → 打开遥控配置窗
  useEffect(() => {
    const h = () => setRemoteMapOpen(true);
    window.addEventListener('repeat:openRemoteMap', h);
    return () => window.removeEventListener('repeat:openRemoteMap', h);
  }, []);

  // ---------- 蓝牙手柄（BLE 私有协议直连桥）：键码 -> 复读动作 ----------
  useEffect(() => {
    const off = window?.ipc?.on?.(
      'bleRemote:event',
      (payload: { type: string; value: string }) => {
        if (!payload) return;
        if (payload.type === 'status') {
          setBleStatus(payload.value);
          if (payload.value === 'connected') touchActiveDevice();
          return;
        }
        if (payload.type !== 'code' || !payload.value) return;
        const runAction = (actionId: string) =>
          remoteActionsRef.current.find((a) => a.id === actionId)?.run?.();
        if (payload.value === '00') {
          // 松开帧：长按未达阈值 → 执行常规动作；已达阈值（长按已触发）→ 不再执行
          const h = bleHoldRef.current;
          if (h) {
            if (h.timer) clearTimeout(h.timer);
            bleHoldRef.current = null;
            runAction(h.actionId);
          }
          return;
        }
        // 按下帧：上一键仍在长按判定中又被新键按下 → 取消判定并执行原动作
        if (bleHoldRef.current) {
          const h = bleHoldRef.current;
          if (h.timer) clearTimeout(h.timer);
          bleHoldRef.current = null;
          runAction(h.actionId);
        }
        const actionId = bleMapRef.current[payload.value];
        if (!actionId) return;
        // 长按清除 AB：B+ 键按住 1 秒、B 点键按住 2 秒（AB 循环激活时）
        const holdMs =
          actionId === 'bFwd' && abRef.current.b != null
            ? 1000
            : actionId === 'setB' && abRef.current.b != null
              ? 2000
              : 0;
        if (holdMs > 0) {
          bleHoldRef.current = {
            code: payload.value,
            actionId,
            timer: setTimeout(() => {
              bleHoldRef.current = null;
              stopAb();
              toast.success(t('toast.abCleared'));
            }, holdMs),
          };
          return;
        }
        runAction(actionId);
      },
    );
    // 挂载即启动桥接：助手内部自动扫描重连，手柄唤醒后即可用，且无需窗口聚焦
    if (activeDevice) {
      void window?.ipc
        ?.invoke('bleRemote:start', {
          name: activeDevice.nameFilter,
          char: activeDevice.charFragment,
        })
        .catch(() => {});
    }
    return () => {
      off?.();
      void window?.ipc?.invoke('bleRemote:stop', {}).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remoteBindings = useMemo(
    () =>
      Object.entries(remoteMap)
        .map(([combo, actionId]) => {
          const act = REMOTE_ACTIONS.find((a) => a.id === actionId);
          if (!act) return null;
          return {
            combo,
            allowInInput: true,
            handler: () => act.run(),
          };
        })
        .filter(Boolean) as {
        combo: string;
        allowInInput: boolean;
        handler: () => void;
      }[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [remoteMap, currentTime, rate],
  );

  useHotkeys(
    active
      ? [
          { combo: 'space', handler: () => togglePlay() },
          // ←/→ 裸键 = 逐帧步进（见下方按住连跳监听）；Shift+←/→ = 快退/快进 5 秒
          { combo: 'shift+arrowleft', handler: () => seekTo(currentTime - 5) },
          { combo: 'shift+arrowright', handler: () => seekTo(currentTime + 5) },
          { combo: 'arrowup', handler: () => locateCue(-1) },
          { combo: 'arrowdown', handler: () => locateCue(1) },
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
          {
            combo: 'escape',
            handler: () => {
              // 有字幕句选中时优先清空选择；否则停止播放
              if (selection.size > 0) {
                setSelection(new Set());
                stopQueue();
              } else {
                stopAll();
              }
            },
          },
          ...remoteBindings,
        ]
      : [],
  );

  // ---------- ←/→ 逐帧步进：按住不松连续逐帧跳（自定义节拍），始终暂停不自动播放 ----------
  const stepFrameRef = useRef(stepFrame);
  stepFrameRef.current = stepFrame;

  useEffect(() => {
    if (!active) return;
    let delayTimer: number | null = null;
    let repeatTimer: number | null = null;
    const stopRepeat = () => {
      if (delayTimer !== null) {
        window.clearTimeout(delayTimer);
        delayTimer = null;
      }
      if (repeatTimer !== null) {
        window.clearInterval(repeatTimer);
        repeatTimer = null;
      }
    };
    const startRepeat = (dir: 1 | -1) => {
      stopRepeat();
      stepFrameRef.current(dir);
      // 长按 250ms 后进入连续步进（30ms/帧 ≈ 33 帧/秒，快于实时）；松开或失焦即停
      delayTimer = window.setTimeout(() => {
        repeatTimer = window.setInterval(() => stepFrameRef.current(dir), 30);
      }, 250);
    };
    const isPlainArrow = (e: KeyboardEvent, key: 'ArrowLeft' | 'ArrowRight') =>
      e.key === key && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return; // 忽略系统自动重复，改用自定义节拍
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      )
        return;
      if (isPlainArrow(e, 'ArrowLeft')) {
        e.preventDefault();
        startRepeat(-1);
      } else if (isPlainArrow(e, 'ArrowRight')) {
        e.preventDefault();
        startRepeat(1);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') stopRepeat();
    };
    const onBlur = () => stopRepeat();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      stopRepeat();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [active]);

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

  // 已收藏句（当前字幕文件）的起始时间集合 → 列表 ★ 标记
  const favoritedStarts = useMemo(() => {
    const s = new Set<string>();
    favorites.forEach((f) => {
      if (f.sourceSubtitle === subtitlePath) s.add(f.start.toFixed(2));
    });
    return s;
  }, [favorites, subtitlePath]);

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

  // 右侧面板（字幕/媒体库/播放列表/收藏）：起始页与工作态共用，可直接点击播放
  const rightPanel = showList ? (
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
            <TabsTrigger value="subtitles" className="h-6 flex-1 px-1 text-xs">
              {t('tabs.subtitles')}
            </TabsTrigger>
            <TabsTrigger value="library" className="h-6 flex-1 px-1 text-xs">
              {t('tabs.library')}
            </TabsTrigger>
            <TabsTrigger value="playlists" className="h-6 flex-1 px-1 text-xs">
              {t('tabs.playlists')}
            </TabsTrigger>
            <TabsTrigger value="favorites" className="h-6 flex-1 px-1 text-xs">
              {t('fav.title')}
            </TabsTrigger>
          </TabsList>
          {/* 内容区手动条件渲染（不经 radix TabsContent）：保证各标签页撑满可视空间 */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {panelTab === 'subtitles' && (
              <>
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <Checkbox
                    checked={cues.length > 0 && selection.size === cues.length}
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
                      {uniqueCueGroups.length > 0 && (
                        <>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <Play className="mr-2 h-3.5 w-3.5" />
                              {t('group.playGroup')}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                              {uniqueCueGroups.map((g) => (
                                <DropdownMenuItem
                                  key={g.index}
                                  onClick={() => playCueGroup(g)}
                                >
                                  <span
                                    className="mr-2 h-2 w-2 flex-shrink-0 rounded-full"
                                    style={{ backgroundColor: g.color }}
                                  />
                                  {t('group.playGroupItem', {
                                    label: g.label,
                                    n: cues.filter(
                                      (c) => cueGroups[c.id]?.index === g.index,
                                    ).length,
                                  })}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      <DropdownMenuLabel>{t('group.auto')}</DropdownMenuLabel>
                      <DropdownMenuItem onClick={applySpeakerGroups}>
                        <User className="mr-2 h-3.5 w-3.5" />
                        {t('group.bySpeaker')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={applyParagraphGroups}>
                        <Pilcrow className="mr-2 h-3.5 w-3.5" />
                        {t('group.byParagraph')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>{t('group.manual')}</DropdownMenuLabel>
                      <DropdownMenuItem onClick={mergeSelectionToGroup}>
                        <Combine className="mr-2 h-3.5 w-3.5" />
                        {t('group.mergeSelected')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={removeSelectionFromGroups}>
                        <Eraser className="mr-2 h-3.5 w-3.5" />
                        {t('group.removeSelected')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setCueGroups({})}>
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        {t('group.clear')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={openGroupManager}>
                        <Settings2 className="mr-2 h-3.5 w-3.5" />
                        {t('group.manage')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>{t('edit.section')}</DropdownMenuLabel>
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
                      searchOpen ? 'text-primary' : 'text-muted-foreground',
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
                        if (checked === true) startSelectionPlayback(selection);
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
                              else if (e.key === 'Escape') setSearchOpen(false);
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
                            onChange={(e) => setReplaceQuery(e.target.value)}
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
                            ? (queueRef.current.list[queueUi.pos]?.idx ?? -1)
                            : -1
                        }
                        selection={selection}
                        onSelectionChange={handleSelectionChange}
                        onRowContextMenu={openCueContextMenu}
                        groups={cueGroups}
                        favoritedStarts={favoritedStarts}
                        searchQuery={searchQuery}
                        activeMatchId={activeMatchId}
                        singleRepeatActive={singleRepeat}
                        onActivate={activateCue}
                        onEdit={(i, patch) => {
                          setCues((prev) => {
                            const next = [...prev];
                            const cue = { ...next[i] };
                            if (patch.text != null) cue.text = patch.text;
                            if (patch.start != null) cue.start = patch.start;
                            if (patch.end != null)
                              cue.end = Math.max(patch.end, cue.start + 0.1);
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
              <MediaLibraryPanel
                ctx={mediaCtx}
                selectedCatId={libSelectedCatId}
                onSelectCategory={setLibSelectedCatId}
                nameMode={nameMode}
                onNameModeChange={setNameMode}
              />
            )}
            {panelTab === 'playlists' && (
              <PlaylistPanel
                ctx={mediaCtx}
                playMode={mediaPlayMode}
                onPlayModeChange={setMediaPlayMode}
                onPlayQueue={playMediaQueue}
                queueInfo={mediaQueueUi}
                onStopQueue={stopMediaQueue}
                nameMode={nameMode}
                onNameModeChange={setNameMode}
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
                groupFilter={favGroupFilter}
                onGroupFilterChange={setFavGroupFilter}
              />
            )}
          </div>
        </Tabs>
      </div>
    </>
  ) : null;

  if (!videoPath) {
    return (
      <div {...dropHandlers} className="relative h-full">
        <div className="flex h-full min-h-0 gap-1">
          <div className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto">
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
                                setRecents((prev) =>
                                  removeRecent(prev, r.path),
                                ),
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
                        <span className="min-w-0 flex-1 truncate">
                          {r.name}
                        </span>
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
          {rightPanel}
        </div>
        {homeMenuElement}
        {/* 字幕样式设置对话框：复用合成页 BasicStyleSettings / AdvancedStyleSettings */}
        <Dialog open={styleDialogOpen} onOpenChange={setStyleDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base">
                {t('vmenu.subtitleStyle')}
              </DialogTitle>
            </DialogHeader>
            <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
              <StylePresets
                activePresetId={
                  STYLE_PRESETS.find((p) =>
                    Object.keys(p.style).every(
                      (k) => p.style[k] === subtitleStyle[k],
                    ),
                  )?.id ?? null
                }
                onSelectPreset={(id) => {
                  const preset = STYLE_PRESETS.find((p) => p.id === id);
                  if (preset)
                    setSubtitleStyle((prev) => ({
                      ...preset.style,
                      autoWrap: prev.autoWrap,
                    }));
                }}
              />
              <BasicStyleSettings
                style={subtitleStyle}
                onUpdateStyle={(updates) =>
                  setSubtitleStyle((prev) => ({ ...prev, ...updates }))
                }
              />
              <AdvancedStyleSettings
                style={subtitleStyle}
                onUpdateStyle={(updates) =>
                  setSubtitleStyle((prev) => ({ ...prev, ...updates }))
                }
                defaultOpen={false}
              />
            </div>
            <DialogFooter className="gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSubtitleStyle(getDefaultStyle());
                  setStyleDialogOpen(false);
                }}
              >
                {t('style.reset')}
              </Button>
              <Button size="sm" onClick={() => setStyleDialogOpen(false)}>
                {t('list.save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {videoMenuElement}
        {propertiesPath && (
          <MediaPropertiesDialog
            open={!!propertiesPath}
            filePath={propertiesPath}
            onClose={() => setPropertiesPath(null)}
          />
        )}
        {remoteMapOpen && (
          <RemoteMapDialog
            open
            onClose={() => setRemoteMapOpen(false)}
            actions={REMOTE_ACTIONS}
            map={remoteMap}
            onChange={setRemoteMap}
            bleStatus={bleStatus}
            onBleToggle={toggleBleRemote}
            bleMap={bleMap}
            onBleMapChange={setBleMap}
            devices={remoteDevices}
            activeDeviceId={activeDevice ? activeDevice.id : ''}
            onUseDevice={useDevice}
            onAddDevice={addDevice}
            onDeleteDevice={deleteDevice}
            onPlayLast={playLastMedia}
            canPlayLast={recents.length > 0}
          />
        )}
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
            variant={dirty ? 'default' : 'outline'}
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
            title={
              libSelectedCatId
                ? `${t('library.favoriteCurrent')} → ${
                    findCategory(library.categories, libSelectedCatId)?.name ||
                    t('library.unfiled')
                  }`
                : t('library.favoriteCurrent')
            }
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
                showTransport ? 'text-primary' : 'text-muted-foreground',
              )}
              onClick={() => setShowTransport((v) => !v)}
              title={
                showTransport
                  ? t('vmenu.hideTransport')
                  : t('vmenu.showTransport')
              }
              aria-label={t('vmenu.showTransport')}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
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
              ref={videoBoxRef}
              className="relative flex min-h-0 flex-1 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-border bg-black"
              onClick={handleMediaClick}
              onDoubleClick={handleMediaDoubleClick}
              onContextMenu={(e) => openVideoMenu(e)}
              title={t('mediaClickHint')}
            >
              {showSubtitle &&
                !isAudioMedia &&
                !mediaError &&
                activeCueIndex >= 0 &&
                cues[activeCueIndex] &&
                videoBoxH > 0 &&
                duration > 0 &&
                (() => {
                  const vv = videoRef.current as HTMLVideoElement | null;
                  const vw = vv?.videoWidth || 16;
                  const vh = vv?.videoHeight || 9;
                  const el = videoBoxRef.current;
                  const scale = Math.min(
                    (el?.clientWidth || 1) / vw,
                    (el?.clientHeight || 1) / vh,
                  );
                  const scaleK = (vh * scale) / LIBASS_SRT_PLAYRES_Y;
                  return (
                    <div
                      className="pointer-events-none absolute"
                      style={{
                        left: `calc(50% - ${(vw * scale) / 2}px)`,
                        top: `calc(50% - ${(vh * scale) / 2}px)`,
                        width: vw * scale,
                        height: vh * scale,
                      }}
                    >
                      {styleDialogOpen ? (
                        <InteractiveSubtitleOverlay
                          style={subtitleStyle}
                          text={cues[activeCueIndex].text}
                          scale={scaleK}
                          onUpdateStyle={(updates) =>
                            setSubtitleStyle((prev) => ({
                              ...prev,
                              ...updates,
                            }))
                          }
                        />
                      ) : (
                        <SubtitlePreviewOverlay
                          style={subtitleStyle}
                          text={cues[activeCueIndex].text}
                          scale={scaleK}
                        />
                      )}
                    </div>
                  );
                })()}
              {shadowPhase === 'rec' && recStream && (
                <ShadowRecordingOverlay stream={recStream} />
              )}
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

            {/* 走带控制条（视频画面右键可显隐） */}
            {showTransport && (
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
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
                  onClick={togglePlay}
                  aria-label={isPlaying ? t('pause') : t('play')}
                  title={isPlaying ? t('pause') : t('play')}
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
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
                <Select
                  value={String(repeatGap)}
                  onValueChange={(v) => setRepeatGap(parseFloat(v))}
                >
                  <SelectTrigger
                    className="h-7 w-[88px] text-xs"
                    aria-label={t('gap.label')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GAP_OPTIONS.map((g) => (
                      <SelectItem key={g} value={String(g)}>
                        {g === 0 ? t('gap.none') : t('gap.seconds', { n: g })}
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
            )}
          </div>

          {rightPanel}
        </div>
      </div>
      {homeMenuElement}

      {/* 归入新建组：输入组名 */}
      <PromptDialog
        open={newGroupTargets != null}
        title={t('group.newCueGroup')}
        placeholder={t('group.newPlaceholder')}
        onSubmit={(value) => createGroupAndAssign(value)}
        onClose={() => setNewGroupTargets(null)}
      />

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

      {/* 字幕样式设置浮动面板：无遮罩、可拖拽、可调大小，视频画面清晰可见实时效果 */}
      {styleDialogOpen && (
        <div
          ref={stylePanelRef}
          className="fixed z-[60] flex flex-col rounded-lg border border-border bg-popover shadow-xl"
          style={{
            left: stylePanelPos.x,
            top: stylePanelPos.y,
            width: stylePanelSize.w,
            height: stylePanelSize.h,
          }}
        >
          <div
            className="flex flex-shrink-0 cursor-move items-center justify-between rounded-t-lg border-b border-border px-3 py-1.5"
            onPointerDown={startStylePanelDrag}
          >
            <span className="text-xs font-medium">
              {t('vmenu.subtitleStyle')}
            </span>
            <button
              type="button"
              onClick={() => setStyleDialogOpen(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5">
            {/* 预设样式 */}
            <div>
              <p className="mb-1 text-[10px] text-muted-foreground">
                {t('meta.presetLabel')}
              </p>
              <StylePresets
                activePresetId={null}
                onSelectPreset={(id) => {
                  const preset = STYLE_PRESETS.find((p) => p.id === id);
                  if (preset)
                    setSubtitleStyle((prev) => ({
                      ...preset.style,
                      autoWrap: prev.autoWrap,
                    }));
                }}
              />
            </div>

            {/* 字体 + 字号 */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">
                  {t('style.font')}
                </span>
                <Select
                  value={subtitleStyle.fontName}
                  onValueChange={(v) =>
                    setSubtitleStyle((p) => ({ ...p, fontName: v }))
                  }
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FONT_LIST.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        <span style={{ fontFamily: f.value }}>{f.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    {t('style.fontSize')}
                  </span>
                  <span className="text-[10px] text-faint">
                    {subtitleStyle.fontSize}px
                  </span>
                </div>
                <div className="flex h-7 items-center">
                  <Slider
                    value={[subtitleStyle.fontSize]}
                    min={FONT_SIZE_RANGE.min}
                    max={FONT_SIZE_RANGE.max}
                    step={1}
                    onValueChange={([v]) =>
                      setSubtitleStyle((p) => ({ ...p, fontSize: v }))
                    }
                    className="w-full"
                  />
                </div>
              </div>
            </div>

            {/* 字体颜色 */}
            <div className="space-y-0.5">
              <span className="text-[10px] text-muted-foreground">
                {t('style.fontColor')}
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={subtitleStyle.primaryColor}
                  onChange={(e) =>
                    setSubtitleStyle((p) => ({
                      ...p,
                      primaryColor: e.target.value,
                    }))
                  }
                  className="h-7 w-8 shrink-0 cursor-pointer rounded border border-border p-0.5"
                />
                <Input
                  value={subtitleStyle.primaryColor}
                  onChange={(e) =>
                    setSubtitleStyle((p) => ({
                      ...p,
                      primaryColor: e.target.value,
                    }))
                  }
                  className="h-7 min-w-0 flex-1 font-mono text-[11px]"
                  placeholder="#FFFFFF"
                />
              </div>
            </div>

            {/* 位置 + 文字样式：紧凑两列 */}
            <div className="grid grid-cols-[auto_1fr] gap-2.5">
              <div>
                <p className="mb-1 text-[10px] text-muted-foreground">
                  {t('style.position')}
                </p>
                <AlignmentSelector
                  value={subtitleStyle.alignment}
                  onChange={(v) =>
                    setSubtitleStyle((p) => ({ ...p, alignment: v }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground">
                  {t('style.textStyle')}
                </p>
                <div className="flex items-center gap-1">
                  {(
                    [
                      ['bold', 'B', 'font-bold'],
                      ['italic', 'I', 'italic'],
                      ['underline', 'U', 'underline'],
                    ] as const
                  ).map(([key, label, cls]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        setSubtitleStyle((p) => ({ ...p, [key]: !p[key] }))
                      }
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded border text-xs transition-colors',
                        subtitleStyle[key]
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span className={cls}>{label}</span>
                    </button>
                  ))}
                  {/* 自动换行开关（缺省开；关闭后仅保留显式换行，长行溢出画面边缘） */}
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() =>
                      setSubtitleStyle((p) => ({
                        ...p,
                        autoWrap: p.autoWrap === false,
                      }))
                    }
                    title={t('style.autoWrap')}
                    className={cn(
                      'flex h-7 items-center gap-1 rounded border px-2 text-[10px] transition-colors',
                      subtitleStyle.autoWrap !== false
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <WrapText className="h-3 w-3" />
                    {t('style.autoWrap')}
                  </button>
                </div>
                {/* 描边 */}
                <div className="flex items-center gap-1.5">
                  <span className="w-6 text-[10px] text-muted-foreground">
                    {t('style.outline')}
                  </span>
                  <div className="flex h-5 flex-1 items-center">
                    <Slider
                      value={[subtitleStyle.outline]}
                      min={0}
                      max={10}
                      step={1}
                      onValueChange={([v]) =>
                        setSubtitleStyle((p) => ({ ...p, outline: v }))
                      }
                      className="w-full"
                    />
                  </div>
                  <span className="w-3 text-right text-[10px] text-faint">
                    {subtitleStyle.outline}
                  </span>
                </div>
                {/* 阴影 */}
                <div className="flex items-center gap-1.5">
                  <span className="w-6 text-[10px] text-muted-foreground">
                    {t('style.shadow')}
                  </span>
                  <div className="flex h-5 flex-1 items-center">
                    <Slider
                      value={[subtitleStyle.shadow]}
                      min={0}
                      max={10}
                      step={1}
                      onValueChange={([v]) =>
                        setSubtitleStyle((p) => ({ ...p, shadow: v }))
                      }
                      className="w-full"
                    />
                  </div>
                  <span className="w-3 text-right text-[10px] text-faint">
                    {subtitleStyle.shadow}
                  </span>
                </div>
              </div>
            </div>

            {/* 边距 */}
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  ['L', subtitleStyle.marginL, 'marginL'],
                  ['R', subtitleStyle.marginR, 'marginR'],
                  ['V', subtitleStyle.marginV, 'marginV'],
                ] as const
              ).map(([label, val, key]) => (
                <div key={key} className="space-y-0.5">
                  <span className="block text-[10px] text-muted-foreground">
                    {t('style.marginShort')} {label}
                  </span>
                  <Input
                    type="number"
                    value={val}
                    onChange={(e) =>
                      setSubtitleStyle((p) => ({
                        ...p,
                        [key]: Number(e.target.value),
                      }))
                    }
                    className="h-6 text-[11px]"
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center justify-end gap-1.5 border-t border-border p-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSubtitleStyle(getDefaultStyle())}
            >
              {t('style.reset')}
            </Button>
            <Button size="sm" onClick={() => setStyleDialogOpen(false)}>
              {t('list.save')}
            </Button>
          </div>
          <div
            className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize"
            onPointerDown={startStylePanelResize}
          />
        </div>
      )}

      {videoMenuElement}
      {propertiesPath && (
        <MediaPropertiesDialog
          open={!!propertiesPath}
          filePath={propertiesPath}
          onClose={() => setPropertiesPath(null)}
        />
      )}
      {remoteMapOpen && (
        <RemoteMapDialog
          open
          onClose={() => setRemoteMapOpen(false)}
          actions={REMOTE_ACTIONS}
          map={remoteMap}
          onChange={setRemoteMap}
          bleStatus={bleStatus}
          onBleToggle={toggleBleRemote}
          bleMap={bleMap}
          onBleMapChange={setBleMap}
          devices={remoteDevices}
          activeDeviceId={activeDevice ? activeDevice.id : ''}
          onUseDevice={useDevice}
          onAddDevice={addDevice}
          onDeleteDevice={deleteDevice}
          onPlayLast={playLastMedia}
          canPlayLast={recents.length > 0}
        />
      )}
      {dragOverlay}
    </div>
  );
}
