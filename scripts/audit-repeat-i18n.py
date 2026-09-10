# -*- coding: utf-8 -*-
"""审计 repeat 模块 i18n：代码 t() 引用的键 vs repeat.json 实际键；并检查单花括号插值。"""
import json, re, glob, sys

locs = {}
for loc in ['zh', 'en']:
    locs[loc] = json.load(open(f'renderer/public/locales/{loc}/repeat.json', encoding='utf-8'))

def flat(d, path=''):
    out = {}
    for k, v in d.items():
        key = f'{path}.{k}' if path else k
        if isinstance(v, dict):
            out.update(flat(v, key))
        else:
            out[key] = v
    return out

flats = {loc: flat(d) for loc, d in locs.items()}

# 收集 repeat 组件里 t('...') 的键
keys = set()
files = glob.glob('renderer/components/repeat/*.tsx') + glob.glob('renderer/components/repeat/*.ts')
for f in files:
    src = open(f, encoding='utf-8').read()
    keys.update(re.findall(r"\bt\('([A-Za-z0-9_.]+)'", src))

missing = sorted(k for k in keys if k not in flats['zh'] or k not in flats['en'])
print('=== missing keys (in code, not in json) ===')
for k in missing:
    print(' ', k, '| zh:', k in flats['zh'], '| en:', k in flats['en'])

print('=== bad single-brace interpolation in json ===')
bad = 0
for loc, f in flats.items():
    for k, v in f.items():
        if isinstance(v, str) and '{' in v:
            for m in re.findall(r'(?<!\{)\{[a-zA-Z_]+\}(?!\})', v):
                print(f'  [{loc}] {k}: {m!r} <- {v!r}')
                bad += 1
if not bad:
    print('  (none)')
