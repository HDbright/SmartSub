import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/** 通用单行输入弹窗：新建/重命名分类、播放列表分组等 */
export function PromptDialog({
  open,
  title,
  initialValue = '',
  placeholder,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  initialValue?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('repeat');
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') onClose();
          }}
        />
        <DialogFooter className="gap-1.5">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('list.cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={!value.trim()}>
            {t('list.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const EMBEDDED_TAG_KEYS = [
  'title',
  'artist',
  'album',
  'date',
  'comment',
] as const;
type EmbeddedTagKey = (typeof EMBEDDED_TAG_KEYS)[number];

const TAG_LABEL_KEYS: Record<EmbeddedTagKey, string> = {
  title: 'meta.tagTitle',
  artist: 'meta.tagArtist',
  album: 'meta.tagAlbum',
  date: 'meta.tagDate',
  comment: 'meta.tagComment',
};

/**
 * 媒体元信息编辑弹窗：
 * - 应用内显示名（媒体库列表展示用）；
 * - 文件内嵌元信息（标题/艺术家/专辑/日期/备注，ffmpeg -c copy 无损重封装写回）；
 * - 封面图（预览当前内嵌封面，支持替换/移除）。
 */
export function MediaMetaDialog({
  open,
  media,
  onSubmit,
  onClose,
}: {
  open: boolean;
  media: {
    id: string;
    path: string;
    name: string;
    kind: 'video' | 'audio';
  } | null;
  onSubmit: (id: string, name: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('repeat');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [tags, setTags] = useState<Record<string, string>>({});
  const [initialTags, setInitialTags] = useState<Record<string, string>>({});
  const [container, setContainer] = useState('');
  const [hasCover, setHasCover] = useState(false);
  const [coverTempFile, setCoverTempFile] = useState<string | null>(null);
  const [coverAction, setCoverAction] = useState<'keep' | 'replace' | 'remove'>(
    'keep',
  );
  const [newCoverPath, setNewCoverPath] = useState<string | null>(null);
  const [embeddedChanged, setEmbeddedChanged] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !media) return;
    setName(media.name);
    setLoading(true);
    setReadFailed(false);
    setTags({});
    setInitialTags({});
    setCoverAction('keep');
    setNewCoverPath(null);
    setEmbeddedChanged(false);
    let cancelled = false;
    (async () => {
      try {
        const res = await window?.ipc?.invoke('mediaMeta:read', {
          filePath: media.path,
        });
        if (cancelled) return;
        if (res?.success && res.data) {
          const tagsFromFile: Record<string, string> = {};
          EMBEDDED_TAG_KEYS.forEach((k) => {
            tagsFromFile[k] = res.data.tags?.[k] || '';
          });
          setTags(tagsFromFile);
          setInitialTags(tagsFromFile);
          setContainer(res.data.container || '');
          setHasCover(!!res.data.hasCover);
          setCoverTempFile(res.data.coverTempFile || null);
        } else {
          setReadFailed(true);
        }
      } catch {
        if (!cancelled) setReadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, media]);

  if (!media) return null;

  const embeddedDirty =
    JSON.stringify(tags) !== JSON.stringify(initialTags) ||
    coverAction !== 'keep';
  const nameChanged = name.trim() !== '' && name.trim() !== media.name;
  const canSave = (nameChanged || embeddedDirty) && !saving;

  const updateTag = (key: EmbeddedTagKey, value: string) => {
    setTags((prev) => {
      const next = { ...prev, [key]: value };
      setEmbeddedChanged(
        JSON.stringify(next) !== JSON.stringify(initialTags) ||
          coverAction !== 'keep',
      );
      return next;
    });
  };

  const chooseCover = async () => {
    const res = await window?.ipc?.invoke('selectFile', { type: 'any' });
    if (res?.canceled || !res?.filePath) return;
    setNewCoverPath(res.filePath as string);
    setCoverAction('replace');
    setEmbeddedChanged(true);
  };

  const rereadMeta = async () => {
    const r2 = await window?.ipc?.invoke('mediaMeta:read', {
      filePath: media.path,
    });
    if (r2?.success && r2.data) {
      const tagsFromFile: Record<string, string> = {};
      EMBEDDED_TAG_KEYS.forEach((k) => {
        tagsFromFile[k] = r2.data.tags?.[k] || '';
      });
      setTags(tagsFromFile);
      setInitialTags(tagsFromFile);
      setHasCover(!!r2.data.hasCover);
      setCoverTempFile(r2.data.coverTempFile || null);
    }
  };

  const submit = async () => {
    if (nameChanged) onSubmit(media.id, name.trim());
    if (embeddedDirty) {
      setSaving(true);
      try {
        const res = await window?.ipc?.invoke('mediaMeta:write', {
          filePath: media.path,
          tags,
          coverAction,
          coverPath: coverAction === 'replace' ? newCoverPath : undefined,
        });
        if (res?.success) {
          toast.success(t('meta.embeddedSaved'));
          await rereadMeta();
          setCoverAction('keep');
          setNewCoverPath(null);
          setEmbeddedChanged(false);
        } else {
          toast.error(t('meta.embeddedFailed', { error: res?.error || '' }));
        }
      } catch (e) {
        toast.error(t('meta.embeddedFailed', { error: String(e) }));
      } finally {
        setSaving(false);
      }
    }
    if (!nameChanged && !embeddedDirty) onClose();
  };

  const coverSrc =
    coverAction === 'replace' && newCoverPath
      ? `media://${encodeURIComponent(newCoverPath)}`
      : coverTempFile
        ? `media://${encodeURIComponent(coverTempFile)}`
        : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t('meta.title')}</DialogTitle>
          <DialogDescription>{t('meta.nameHint')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t('meta.nameLabel')}
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving && canSave) submit();
              }}
            />
          </div>

          <div className="space-y-1.5 rounded-md border border-border p-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{t('meta.embedded')}</span>
              {container && (
                <span className="text-[10.5px] text-faint">
                  {t('meta.containerLabel')} {container}
                </span>
              )}
              {loading && (
                <span className="text-[11px] text-muted-foreground">
                  {t('meta.reading')}
                </span>
              )}
            </div>
            {readFailed ? (
              <p className="text-[11px] text-muted-foreground">
                {t('meta.readFail')}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    ['title', 'artist', 'album', 'date'] as EmbeddedTagKey[]
                  ).map((k) => (
                    <div key={k} className="space-y-0.5">
                      <span className="text-[10.5px] text-muted-foreground">
                        {t(TAG_LABEL_KEYS[k])}
                      </span>
                      <Input
                        className="h-7 text-xs"
                        value={tags[k] || ''}
                        onChange={(e) => updateTag(k, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10.5px] text-muted-foreground">
                    {t('meta.tagComment')}
                  </span>
                  <Textarea
                    rows={2}
                    className="min-h-0 text-xs"
                    value={tags.comment || ''}
                    onChange={(e) => updateTag('comment', e.target.value)}
                  />
                </div>

                <div className="space-y-1 pt-1">
                  <span className="text-[10.5px] text-muted-foreground">
                    {t('meta.cover')}
                  </span>
                  <div className="flex items-start gap-2">
                    <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/40">
                      {coverSrc ? (
                        <img
                          src={coverSrc}
                          alt="cover"
                          className="max-h-20 max-w-20 object-contain"
                        />
                      ) : (
                        <span className="px-1 text-center text-[10px] text-muted-foreground">
                          {t('meta.noCover')}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <Button
                        variant={
                          coverAction === 'replace' ? 'default' : 'outline'
                        }
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={chooseCover}
                      >
                        {t('meta.coverReplace')}
                      </Button>
                      <Button
                        variant={
                          coverAction === 'remove' ? 'default' : 'outline'
                        }
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        disabled={!hasCover}
                        onClick={() => setCoverAction('remove')}
                      >
                        {t('meta.coverRemove')}
                      </Button>
                      <Button
                        variant={coverAction === 'keep' ? 'default' : 'outline'}
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => {
                          setCoverAction('keep');
                          setNewCoverPath(null);
                          setEmbeddedChanged(
                            JSON.stringify(tags) !==
                              JSON.stringify(initialTags),
                          );
                        }}
                      >
                        {t('meta.coverKeep')}
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t('meta.kindLabel')}
            </span>
            <div className="text-xs">
              {media.kind === 'audio'
                ? t('meta.kindAudio')
                : t('meta.kindVideo')}
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t('meta.pathLabel')}
            </span>
            <div className="max-h-16 overflow-y-auto break-all rounded bg-muted/50 p-1.5 font-mono text-[11px] text-muted-foreground">
              {media.path}
            </div>
          </div>
        </div>
        <DialogFooter className="gap-1.5">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('list.cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave}>
            {saving ? t('meta.writing') : t('list.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface MediaProbeInfo {
  container: string;
  duration: number;
  bitrate: string;
  fileSize: number;
  hasCover: boolean;
  tags: Record<string, string>;
  videoStream: { codec: string; detail: string } | null;
  audioStream: { codec: string; detail: string } | null;
}

/** 媒体文件属性查看弹窗：只读详细属性信息 */
export function MediaPropertiesDialog({
  open,
  filePath,
  onClose,
}: {
  open: boolean;
  filePath: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('repeat');
  const [info, setInfo] = useState<MediaProbeInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !filePath) return;
    setLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const res = await window?.ipc?.invoke('mediaMeta:read', { filePath });
        const stat = await window?.ipc?.invoke('mediaFile:stat', { filePath });
        if (!cancelled && res?.success && res.data) {
          setInfo({
            container: res.data.container || '',
            duration: res.data.duration || 0,
            bitrate: res.data.bitrate || '',
            fileSize: stat?.success ? stat.data?.size || 0 : 0,
            hasCover: !!res.data.hasCover,
            tags: res.data.tags || {},
            videoStream: res.data.videoStream || null,
            audioStream: res.data.audioStream || null,
          });
        }
      } catch {
        /* 忽略 */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, filePath]);

  const fmtSize = (b: number) => {
    if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
    return Math.round(b / 1024) + ' KB';
  };
  const fmtDur = (s: number) => {
    const m = Math.floor(s / 60);
    return (
      String(m).padStart(2, '0') +
      ':' +
      String(Math.floor(s % 60)).padStart(2, '0')
    );
  };

  const rows: [string, string][] = info
    ? [
        [t('meta.pathLabel'), filePath],
        [t('prop.container'), info.container],
        [t('prop.duration'), fmtDur(info.duration)],
        [t('prop.bitrate'), info.bitrate || '-'],
        [t('prop.fileSize'), fmtSize(info.fileSize)],
        ...(info.videoStream
          ? ([
              [t('prop.videoCodec'), info.videoStream.codec],
              [t('prop.resolution'), info.videoStream.detail],
            ] as [string, string][])
          : []),
        ...(info.audioStream
          ? ([
              [t('prop.audioCodec'), info.audioStream.codec],
              [t('prop.sampleRate'), info.audioStream.detail],
            ] as [string, string][])
          : []),
        [t('meta.tagTitle'), info.tags?.title || '-'],
        [t('meta.tagArtist'), info.tags?.artist || '-'],
        [t('meta.tagDate'), info.tags?.date || '-'],
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{t('prop.title')}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {t('meta.reading')}
          </p>
        ) : (
          <div className="max-h-[60vh] space-y-0.5 overflow-y-auto">
            {rows.map(([label, value]) => (
              <div
                key={label}
                className="flex items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent/50"
              >
                <span className="w-20 flex-shrink-0 text-muted-foreground">
                  {label}
                </span>
                <span className="min-w-0 flex-1 break-all">{value}</span>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
