import { app, ipcMain, shell } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import { logMessage } from './storeManager';

/**
 * 媒体文件内嵌元信息与封面的读取/写入（无损）。
 * 原理：ffmpeg -c copy 重封装容器，仅改写元数据/封面流，音视频流原样拷贝。
 * 读：解析 `ffmpeg -i` 的 stderr 元数据块；封面经 `-map 0:t:0` 抽到临时图片做预览。
 * 写：`-map 0 -map -0:t` 去掉旧封面（可选），需要时把新图片作为 attached_pic 挂回，
 *     输出到临时文件后原子替换原文件；音频容器额外写 ID3v2.3。
 */

const ffmpegPath = (ffmpegStatic as unknown as string).replace(
  'app.asar',
  'app.asar.unpacked',
);

const READ_TIMEOUT_MS = 30000;
const WRITE_TIMEOUT_MS = 10 * 60 * 1000;

function execFfmpeg(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        const code =
          err && typeof (err as any).code === 'number'
            ? (err as any).code
            : err
              ? 1
              : 0;
        resolve({ code, stderr: stderr || '' });
      },
    );
  });
}

const READABLE_TAG_KEYS = [
  'title',
  'artist',
  'album',
  'date',
  'comment',
  'genre',
] as const;
export type MediaTagKey = (typeof READABLE_TAG_KEYS)[number];

interface StreamInfo {
  codec: string;
  detail: string;
}

interface ParsedMeta {
  container: string;
  duration: number;
  bitrate: string;
  tags: Partial<Record<MediaTagKey, string>>;
  hasCover: boolean;
  coverTempFile: string | null;
  videoStream: StreamInfo | null;
  audioStream: StreamInfo | null;
}

/** 解析 `ffmpeg -i` 的 stderr：元数据块 + attached pic 检测 */
async function readMeta(
  filePath: string,
  opts?: { skipCover?: boolean },
): Promise<ParsedMeta> {
  const { stderr } = await execFfmpeg(
    ['-hide_banner', '-i', filePath],
    READ_TIMEOUT_MS,
  );
  // Windows 下 ffmpeg 按文本模式输出 CRLF；行尾残留的 \r 会破坏逐行正则（$ 锚点），先统一为 \n
  const lines = stderr.replace(/\r\n/g, '\n');
  if (!lines.includes('Input #0')) {
    // ffmpeg 未执行成功（如二进制损坏/被占用）：显式失败，让上层展示读取失败而非静默空值
    throw new Error(
      stderr.split('\n').filter(Boolean).pop()?.slice(0, 200) ||
        'ffmpeg probe failed',
    );
  }

  const meta: ParsedMeta = {
    container: '',
    duration: 0,
    bitrate: '',
    tags: {},
    hasCover: false,
    coverTempFile: null,
    videoStream: null,
    audioStream: null,
  };

  const inputIdx = lines.indexOf('Input #0');
  const inputBlock = inputIdx >= 0 ? lines.slice(inputIdx) : lines;

  const containerMatch = inputBlock.match(/Input #0,\s*([^,]+),/);
  if (containerMatch) meta.container = containerMatch[1].trim();

  const durationMatch = inputBlock.match(
    /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/,
  );
  if (durationMatch) {
    meta.duration =
      Number(durationMatch[1]) * 3600 +
      Number(durationMatch[2]) * 60 +
      Number(durationMatch[3]) +
      Number(durationMatch[4]) / 100;
  }

  // 元数据块：位于 "Metadata:" 与 "Duration:"/第一个 "Stream #" 之间
  const metaStart = inputBlock.indexOf('Metadata:');
  if (metaStart >= 0) {
    const after = inputBlock.slice(metaStart + 'Metadata:'.length);
    const blockEnd = Math.min(
      ...[after.indexOf('Duration:'), after.indexOf('Stream #')].filter(
        (n) => n >= 0,
      ),
    );
    const block = after.slice(0, blockEnd >= 0 ? blockEnd : undefined);
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if ((READABLE_TAG_KEYS as readonly string[]).includes(key)) {
        const val = m[2].trim();
        if (val && !meta.tags[key as MediaTagKey])
          meta.tags[key as MediaTagKey] = val;
      }
    }
  }

  // 码率
  const br = inputBlock.match(/bitrate:\s*(\d+\s*kb\/s)/);
  if (br) meta.bitrate = br[1];

  // 流信息（视频/音频编解码器、分辨率、采样率等）
  for (const line of inputBlock.split('\n')) {
    const sm = line.match(/Stream #0:\d+.*:\s+(Video|Audio):\s*([^,\s(]+)/);
    if (!sm) continue;
    const type = sm[1];
    const codec = sm[2].trim();
    let detail = '';
    if (type === 'Video') {
      const res = line.match(/(\d{2,5})x(\d{2,5})/);
      const fps = line.match(/([\d.]+)\s*fps/);
      detail = [res ? res[1] + 'x' + res[2] : '', fps ? fps[1] + ' fps' : '']
        .filter(Boolean)
        .join(', ');
    } else {
      const hz = line.match(/(\d+)\s*Hz/);
      const ch = line.match(/(stereo|mono|\d+\s*channels?)/);
      detail = [hz ? hz[1] + ' Hz' : '', ch ? ch[1] : '']
        .filter(Boolean)
        .join(', ');
    }
    const info = { codec, detail };
    if (type === 'Video' && !meta.videoStream) meta.videoStream = info;
    if (type === 'Audio' && !meta.audioStream) meta.audioStream = info;
  }

  meta.hasCover = /attached pic/i.test(inputBlock);

  // 抽出当前封面到临时文件做预览（重编码为 jpg，仅预览用途）
  if (meta.hasCover && !opts?.skipCover) {
    const tmp = path.join(
      app.getPath('temp'),
      `smartsub-cover-${Date.now()}.jpg`,
    );
    const { code } = await execFfmpeg(
      ['-y', '-i', filePath, '-map', '0:t:0', '-frames:v', '1', tmp],
      READ_TIMEOUT_MS,
    );
    if (code === 0 && fs.existsSync(tmp)) meta.coverTempFile = tmp;
  }

  return meta;
}

ipcMain.handle('mediaFile:stat', async (_e, { filePath }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'file not found' };
    }
    const stat = fs.statSync(filePath);
    return { success: true, data: { size: stat.size } };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

function buildWriteArgs(
  filePath: string,
  tags: Partial<Record<MediaTagKey, string>>,
  coverAction: 'keep' | 'replace' | 'remove',
  coverPath: string | undefined,
  outFile: string,
): string[] {
  const args = ['-y', '-hide_banner', '-i', filePath];
  const isMp3 = /\.mp3$/i.test(filePath);
  if (coverAction === 'replace' && coverPath) args.push('-i', coverPath);

  args.push('-map', '0');
  // 替换/移除封面：先去掉旧的 attached_pic 流
  if (coverAction !== 'keep') args.push('-map', '-0:t');
  if (coverAction === 'replace' && coverPath) {
    args.push(
      '-map',
      '1',
      '-c:v:0',
      'mjpeg',
      '-disposition:v:0',
      'attached_pic',
    );
  }

  args.push('-c', 'copy');
  if (isMp3) args.push('-id3v2_version', '3', '-write_id3v1', '1');

  // 显式设置的标签覆盖原值；未设置的键不传，保留原值
  for (const key of READABLE_TAG_KEYS) {
    const val = tags[key];
    if (val != null && val !== '') args.push(`-metadata`, `${key}=${val}`);
  }

  args.push(outFile);
  return args;
}

/**
 * 读取媒体文件原始字节（供渲染层 Web Audio decodeAudioData 解析波形）。
 * 打包环境下页面源是 app://- 自定义协议，fetch('media://…') 跨协议会被拒
 * （dev 是 http://localhost 所以正常），因此统一走 IPC 传输字节。
 */
ipcMain.handle('mediaFile:readBuffer', async (_e, { filePath }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'file not found' };
    }
    const buf = await fs.promises.readFile(filePath);
    return { success: true, data: buf };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
});

export function setupMediaMetaHandlers() {
  ipcMain.handle('mediaFile:reveal', async (_e, { filePath }) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: 'file not found' };
      }
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('mediaMeta:readTags', async (_e, { filePath }) => {
    // 轻量读取：仅解析标签，不抽封面（供列表显示名称用）
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: 'file not found' };
      }
      const meta = await readMeta(filePath, { skipCover: true });
      return { success: true, data: { tags: meta.tags } };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('mediaMeta:read', async (_e, { filePath }) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: 'file not found' };
      }
      const meta = await readMeta(filePath);
      return { success: true, data: meta };
    } catch (e) {
      logMessage(`读取媒体内嵌元信息失败: ${(e as Error).message}`, 'warning');
      return { success: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(
    'mediaMeta:write',
    async (_e, { filePath, tags, coverAction, coverPath }) => {
      // 临时输出放在目标文件同目录，避免跨盘 rename（EXDEV）导致原子替换失败
      const dir = path.dirname(filePath);
      const ext = path.extname(filePath) || '.tmp';
      const tmpOut = path.join(
        dir,
        `.smartsub-meta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
      );
      try {
        if (!filePath || !fs.existsSync(filePath)) {
          return { success: false, error: 'file not found' };
        }
        const args = buildWriteArgs(
          filePath,
          tags || {},
          coverAction || 'keep',
          coverPath,
          tmpOut,
        );
        const { code, stderr } = await execFfmpeg(args, WRITE_TIMEOUT_MS);
        logMessage(
          `mediaMeta:write ffmpeg exit=${code} file=${path.basename(filePath)}`,
          code !== 0 ? 'warning' : 'info',
        );
        if (
          code !== 0 ||
          !fs.existsSync(tmpOut) ||
          fs.statSync(tmpOut).size === 0
        ) {
          const hint =
            stderr.split('\n').filter(Boolean).pop() || 'ffmpeg failed';
          throw new Error(hint.slice(0, 300));
        }
        // 原子替换原文件；若仍遇跨盘（EXDEV）则退化为拷贝+删除
        try {
          fs.renameSync(tmpOut, filePath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
            fs.copyFileSync(tmpOut, filePath);
            fs.unlinkSync(tmpOut);
          } else {
            throw e;
          }
        }
        logMessage(`媒体元信息已写入: ${filePath}`, 'info');
        return { success: true };
      } catch (e) {
        try {
          if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        } catch {
          /* 忽略 */
        }
        logMessage(`写入媒体元信息失败: ${(e as Error).message}`, 'warning');
        return { success: false, error: (e as Error).message };
      }
    },
  );
}
