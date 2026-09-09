import React, { useEffect, useState } from 'react';
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

/**
 * 媒体元信息查看/编辑弹窗：名称可改（列表展示与排序依据），路径只读。
 * media 为空时不渲染。
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

  useEffect(() => {
    if (open && media) setName(media.name);
  }, [open, media]);

  if (!media) return null;

  const submit = () => {
    const v = name.trim();
    if (!v) return;
    onSubmit(media.id, v);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t('meta.title')}</DialogTitle>
          <DialogDescription>{t('meta.nameHint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t('meta.nameLabel')}
            </span>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
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
          <Button size="sm" onClick={submit} disabled={!name.trim()}>
            {t('list.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
