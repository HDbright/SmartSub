# -*- coding: utf-8 -*-
"""数据销毁链三重修复：空表崩溃根因 + 载入失败禁止覆盖 + 启动备份"""
import io

p = 'main/helpers/repeatLibraryDb.ts'
s = io.open(p, encoding='utf-8').read()

# 1. 根因修复：sql.js 对空表 exec 返回 []，rowsToObjects 必须容忍
old = """function rowsToObjects(res: any): any[] {
  const columns = res[0];
  const values = res[1];
  return values.map((row: any[]) => {
    const obj: Record<string, any> = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj;
  });
}"""
new = """function rowsToObjects(res: any): any[] {
  // sql.js 对空表（无行）返回 []：res[0]/res[1] 均为 undefined，必须按空结果处理，
  // 否则任意一张空表都会让 loadAll 崩溃 → 渲染层空载 → 保存时覆盖整库（数据销毁链）
  if (!res || !res.length) return [];
  const columns = res[0];
  const values = res[1];
  return values.map((row: any[]) => {
    const obj: Record<string, any> = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj;
  });
}"""
assert s.count(old) == 1, 'rowsToObjects anchor'
s = s.replace(old, new)

# 2. 会话级载入失败标记 + 启动备份
old = """let db: any = null;
let dbFile = '';"""
new = """let db: any = null;
let dbFile = '';
let sessionLoadFailed = false;"""
assert s.count(old) == 1
s = s.replace(old, new)

old = """  dbFile = path.join(app.getPath('userData'), 'repeat-library.sqlite3');
  db = fs.existsSync(dbFile)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(dbFile)))
    : new SQL.Database();
  db.run(SCHEMA);
  persist();"""
new = """  dbFile = path.join(app.getPath('userData'), 'repeat-library.sqlite3');
  // 每次会话首次打开前留一份启动备份：任何后续覆盖事故都可从 .bak 恢复
  try {
    if (fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0) {
      fs.copyFileSync(dbFile, dbFile + '.bak');
    }
  } catch {
    /* 备份失败不阻断启动 */
  }
  db = fs.existsSync(dbFile)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(dbFile)))
    : new SQL.Database();
  db.run(SCHEMA);
  persist();"""
assert s.count(old) == 1
s = s.replace(old, new)

# 3. load 失败置会话标记
old = """    } catch (e) {
      logMessage(
        `复读媒体库 SQLite 读取失败: ${(e as Error).message}`,
        'error',
      );
      return { success: false, empty: true, data: null };
    }
  });

  ipcMain.handle('repeatLib:saveAll', async (_event, payload) => {
    try {
      await getDb();
      saveAll(payload);
      return { success: true };
    } catch (e) {
      logMessage(
        `复读媒体库 SQLite 保存失败: ${(e as Error).message}`,
        'error',
      );
      return { success: false, error: (e as Error).message };
    }
  });"""
new = """    } catch (e) {
      sessionLoadFailed = true;
      logMessage(
        `复读媒体库 SQLite 读取失败: ${(e as Error).message}`,
        'error',
      );
      return { success: false, empty: true, data: null };
    }
  });

  ipcMain.handle('repeatLib:saveAll', async (_event, payload) => {
    try {
      await getDb();
      // 载入失败过的会话禁止整包保存：防止把空状态覆盖回有数据的库
      if (sessionLoadFailed) {
        return {
          success: false,
          error: 'load-failed-guard: 载入失败期间禁止写入，防止覆盖既有数据',
        };
      }
      saveAll(payload);
      return { success: true };
    } catch (e) {
      logMessage(
        `复读媒体库 SQLite 保存失败: ${(e as Error).message}`,
        'error',
      );
      return { success: false, error: (e as Error).message };
    }
  });"""
assert s.count(old) == 1, 'load/save anchors'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('main guards ok')

# 4. 渲染层：载入失败时不解锁自动保存 + 提示
p2 = 'renderer/components/repeat/mediaLibrary.ts'
s2 = io.open(p2, encoding='utf-8').read()
old2 = """      try {
        const res = await window?.ipc?.invoke('repeatLib:load');
        if (res?.success && res.data) dbData = res.data;
      } catch {
        /* 旧主进程无此通道，走下方迁移 */
      }
      if (cancelled) return;
      if (dbData) {
        setLibrary(dbData.library);
        setPlaylists(dbData.playlists || []);
        setRecents(dbData.recents || []);
        setFavorites(dbData.favorites || []);
        setFavGroups(dbData.favGroups || []);
        loadedRef.current = true;
        return;
      }"""
new2 = """      try {
        const res = await window?.ipc?.invoke('repeatLib:load');
        if (res?.success && res.data) dbData = res.data;
        if (res && res.success === false && !cancelled) {
          // 载入失败（如打包环境 wasm 缺失）：保持 loadedRef=false 冻结自动保存，
          // 防止把空状态覆盖回有数据的库；loadedRef 留待下次成功载入
          toast.error(
            '媒体库载入失败，为保护数据已暂停自动保存，请重启应用重试',
          );
          loadedRef.current = false;
          return;
        }
      } catch {
        /* 旧主进程无此通道，走下方迁移 */
      }
      if (cancelled) return;
      if (dbData) {
        setLibrary(dbData.library);
        setPlaylists(dbData.playlists || []);
        setRecents(dbData.recents || []);
        setFavorites(dbData.favorites || []);
        setFavGroups(dbData.favGroups || []);
        loadedRef.current = true;
        return;
      }"""
assert s2.count(old2) == 1, 'renderer load anchor'
s2 = s2.replace(old2, new2)

# toast 导入检查
if "from 'sonner'" not in s2:
    old_imp = "import { useTranslation } from 'next-i18next';"
    assert s2.count(old_imp) == 1
    s2 = s2.replace(old_imp, old_imp + "\nimport { toast } from 'sonner';")

io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('renderer guard ok')
