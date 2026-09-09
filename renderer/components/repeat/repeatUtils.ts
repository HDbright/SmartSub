/**
 * 复读页共用类型与时间工具。
 * 字幕时间在组件内部一律以「秒」参与运算，仅在载入/保存字幕文件时与 "00:00:01,000" 风格互转。
 */

export interface RepeatCue {
  id: string;
  start: number; // 秒
  end: number; // 秒
  text: string; // 多行字幕以 \n 连接
}

export interface WavePeaks {
  min: Float32Array;
  max: Float32Array;
  n: number;
}

/** 解析 "00:00:01,000 --> 00:00:03,000" 为秒区间 */
export function parseStartEndTime(range: string): {
  start: number;
  end: number;
} {
  const [s, e] = (range || '').split('-->');
  return { start: parseSrtTime(s), end: parseSrtTime(e) };
}

/** 解析 "hh:mm:ss,mmm" / "mm:ss.mmm" 时间戳为秒 */
export function parseSrtTime(stamp?: string): number {
  if (!stamp) return 0;
  const m = stamp.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return h * 3600 + min * 60 + sec + ms / 1000;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 秒 → "00:00:01,000"（保存字幕用） */
export function formatSrtClock(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms % 1000).padStart(3, '0')}`;
}

/** 秒 → "01:23.4"（列表/波形展示用） */
export function formatShort(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '--:--.-';
  const total = Math.max(0, sec);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const d = Math.floor((total * 10) % 10);
  return `${pad2(m)}:${pad2(s)}.${d}`;
}

/** 秒 → "01:23"（播放器时间轴用） */
export function formatClock(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '--:--';
  const total = Math.max(0, sec);
  return `${pad2(Math.floor(total / 60))}:${pad2(Math.floor(total % 60))}`;
}

/**
 * 解析用户在编辑框输入的时间：接受 "72.5" / "1:12.5" / "01:12,500" / "00:01:12.500"。
 * 返回秒；无法解析返回 null。
 */
export function parseClockInput(text: string): number | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const m = t.match(/^(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

// ----------------------------- 字幕分组 -----------------------------

/** 分组标记色板（循环使用） */
export const GROUP_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
];

export interface CueGroup {
  index: number; // 组序号（从 1 起）
  label: string; // 组标签（说话人名 / 段 n / 组 n）
  color: string;
}

export type GroupAssignment = Record<string, CueGroup>;

/**
 * 按说话人分组：取每条字幕首行 "XXX：" / "XXX:" 前缀作为说话人；
 * 同一说话人全文归为一组；无前缀的句子不分组。
 */
export function groupBySpeaker(cues: RepeatCue[]): {
  assignment: GroupAssignment;
  count: number;
} {
  const order: string[] = [];
  const assignment: GroupAssignment = {};
  cues.forEach((cue) => {
    const firstLine = cue.text.split('\n')[0] || '';
    const m = firstLine.match(/^\s*([^\s:：]{1,12})\s*[:：]/);
    if (!m) return;
    const speaker = m[1];
    if (!order.includes(speaker)) order.push(speaker);
    const idx = order.indexOf(speaker);
    assignment[cue.id] = {
      index: idx + 1,
      label: speaker,
      color: GROUP_COLORS[idx % GROUP_COLORS.length],
    };
  });
  return { assignment, count: order.length };
}

/**
 * 按自然段分组：相邻字幕的间隙超过 gapSec 秒即断开为新段
 * （旁白停顿/换场景），labelFn 生成标签（段 n）。
 */
export function groupByParagraph(
  cues: RepeatCue[],
  gapSec: number,
  labelFn: (n: number) => string,
): { assignment: GroupAssignment; count: number } {
  const assignment: GroupAssignment = {};
  let n = 0;
  let prevEnd = Number.NEGATIVE_INFINITY;
  cues.forEach((cue) => {
    if (cue.start - prevEnd > gapSec) n += 1;
    assignment[cue.id] = {
      index: n,
      label: labelFn(n),
      color: GROUP_COLORS[(n - 1) % GROUP_COLORS.length],
    };
    prevEnd = Math.max(prevEnd, cue.end);
  });
  return { assignment, count: n };
}
