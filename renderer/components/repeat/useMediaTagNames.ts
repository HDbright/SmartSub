/**
 * 媒体内嵌标签（title/album）批量探测 hook：供列表「显示名称」模式使用。
 * - 会话级模块缓存：同一文件本会话只探测一次，面板切换/重挂载不重复跑 ffmpeg；
 * - 顺序探测（每次一个 ffmpeg），避免大列表并发打满 CPU；已探测完的先渲染，未到的行回退文件名。
 */

import { useEffect, useState } from 'react';

export interface MediaTagNames {
  title?: string;
  album?: string;
}

const tagCache = new Map<string, MediaTagNames>();
const probing = new Set<string>();

export function useMediaTagNames(
  paths: string[],
): Record<string, MediaTagNames> {
  const [, setTick] = useState(0);
  const key = paths.join('\n');

  useEffect(() => {
    const missing = Array.from(new Set(paths)).filter(
      (p) => p && !tagCache.has(p) && !probing.has(p),
    );
    if (!missing.length) return;
    missing.forEach((p) => probing.add(p));
    let cancelled = false;
    (async () => {
      for (const p of missing) {
        let data: MediaTagNames = {};
        try {
          const res = await window?.ipc?.invoke('mediaMeta:readTags', {
            filePath: p,
          });
          if (res?.success && res.data?.tags) {
            data = {
              title: res.data.tags.title || undefined,
              album: res.data.tags.album || undefined,
            };
          }
        } catch {
          /* 探测失败按无标签处理 */
        }
        tagCache.set(p, data);
        probing.delete(p);
        if (cancelled) return;
        setTick((v) => v + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
    // paths 以拼接串做依赖，避免每次渲染的新数组引用触发重复探测
  }, [key]);

  const out: Record<string, MediaTagNames> = {};
  tagCache.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
