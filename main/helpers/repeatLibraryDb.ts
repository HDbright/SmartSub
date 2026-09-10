import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logMessage } from './storeManager';

/**
 * 复读页媒体库 / 播放列表 / 最近播放的 SQLite 持久化（sql.js，纯 WASM，无需本地编译）。
 * 数据量小（几十~几百行），渲染层每次变更整包提交，主进程单事务全量重写后落盘到
 * userData/repeat-library.sqlite3。
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs = require('sql.js');

let db: any = null;
let dbFile = '';
let sessionLoadFailed = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS category_media (
  category_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  sort INTEGER NOT NULL,
  PRIMARY KEY (category_id, media_id)
);
CREATE TABLE IF NOT EXISTS root_media (
  media_id TEXT PRIMARY KEY,
  sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_media (
  playlist_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  sort INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, media_id)
);
CREATE TABLE IF NOT EXISTS recents (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  subtitle_path TEXT
);
CREATE TABLE IF NOT EXISTS favorite_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorite_cues (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source_subtitle TEXT NOT NULL,
  video_path TEXT NOT NULL,
  start REAL NOT NULL,
  end REAL NOT NULL,
  created_at INTEGER NOT NULL,
  group_id TEXT,
  sort INTEGER NOT NULL
);
`;

function resolveWasmPath(): string {
  const candidates = [
    path.join(
      app.getAppPath(),
      'node_modules',
      'sql.js',
      'dist',
      'sql-wasm.wasm',
    ),
    path.join(
      __dirname,
      '..',
      'node_modules',
      'sql.js',
      'dist',
      'sql-wasm.wasm',
    ),
    path.join(process.resourcesPath || '', 'sql-wasm.wasm'),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* 忽略 */
    }
  }
  throw new Error('sql-wasm.wasm not found');
}

function rowsToObjects(res: any): any[] {
  // sql.js 的 exec 返回 [{ columns: string[], values: any[][] }] —— 每个结果集一个对象；
  // 空表/无行时结果集内 values 为空数组，甚至整个返回 []。此前误按 [列, 行] 二元组解析，
  // res[1] 恒为 undefined 导致每次 SELECT 必崩、加载从未成功过。
  if (!res || !res.length) return [];
  const out: any[] = [];
  for (const set of res) {
    const columns = set?.columns;
    const values = set?.values;
    if (!columns || !values) continue;
    for (const row of values) {
      const obj: Record<string, any> = {};
      columns.forEach((col: string, i: number) => {
        obj[col] = row[i];
      });
      out.push(obj);
    }
  }
  return out;
}

function queryAll(sql: string): any[] {
  return rowsToObjects(db.exec(sql));
}

function run(sql: string, params?: any[]) {
  db.run(sql, params);
}

function persist() {
  const data = db.export();
  fs.writeFileSync(dbFile, Buffer.from(data));
}

async function getDb(): Promise<any> {
  if (db) return db;
  const SQL = await initSqlJs({
    wasmBinary: fs.readFileSync(resolveWasmPath()),
  });
  dbFile = path.join(app.getPath('userData'), 'repeat-library.sqlite3');
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
  persist();
  logMessage(`复读媒体库 SQLite 已就绪: ${dbFile}`, 'info');
  return db;
}

function loadAll() {
  const media: Record<string, any> = {};
  for (const row of queryAll('SELECT * FROM media ORDER BY rowid')) {
    media[row.id] = {
      id: row.id,
      path: row.path,
      name: row.name,
      kind: row.kind,
      addedAt: row.added_at,
    };
  }

  const childrenOf: Record<string, any[]> = {};
  const topLevel: any[] = [];
  const catRows = queryAll('SELECT * FROM categories ORDER BY sort, rowid');
  catRows.forEach((row) => {
    const node = {
      id: row.id,
      name: row.name,
      children: [],
      mediaIds: [] as string[],
    };
    if (row.parent_id) {
      (childrenOf[row.parent_id] ||= []).push(node);
    } else {
      topLevel.push(node);
    }
  });
  // 挂接子树（自顶向下两遍即可，深度任意：先收集 childrenOf，再递归装配）
  const attach = (node: any) => {
    node.children = childrenOf[node.id] || [];
    node.children.forEach(attach);
  };
  topLevel.forEach(attach);

  for (const row of queryAll(
    'SELECT category_id, media_id FROM category_media ORDER BY sort, rowid',
  )) {
    const hit = (id: string): any => {
      for (const top of topLevel) {
        const stack = [top];
        while (stack.length) {
          const n = stack.pop();
          if (n.id === id) return n;
          n.children.forEach((c: any) => stack.push(c));
        }
      }
      return null;
    };
    hit(row.category_id)?.mediaIds.push(row.media_id);
  }

  const rootMediaIds = queryAll(
    'SELECT media_id FROM root_media ORDER BY sort, rowid',
  ).map((r: any) => r.media_id);

  const playlists = queryAll(
    'SELECT * FROM playlists ORDER BY sort, rowid',
  ).map((row: any) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    mediaIds: [] as string[],
  }));
  for (const row of queryAll(
    'SELECT playlist_id, media_id FROM playlist_media ORDER BY sort, rowid',
  )) {
    playlists
      .find((p: any) => p.id === row.playlist_id)
      ?.mediaIds.push(row.media_id);
  }

  const recents = queryAll('SELECT * FROM recents ORDER BY played_at DESC').map(
    (row: any) => ({
      path: row.path,
      name: row.name,
      kind: row.kind,
      playedAt: row.played_at,
      subtitlePath: row.subtitle_path || undefined,
    }),
  );

  const favGroups = queryAll(
    'SELECT * FROM favorite_groups ORDER BY sort, rowid',
  ).map((row: any) => ({
    id: row.id,
    name: row.name,
  }));

  const favorites = queryAll(
    'SELECT * FROM favorite_cues ORDER BY created_at DESC, sort',
  ).map((row: any) => ({
    id: row.id,
    text: row.text,
    sourceSubtitle: row.source_subtitle,
    videoPath: row.video_path,
    start: row.start,
    end: row.end,
    createdAt: row.created_at,
    groupId: row.group_id || null,
  }));

  return {
    library: { categories: topLevel, rootMediaIds, media },
    playlists,
    recents,
    favorites,
    favGroups,
  };
}

function isEmpty(): boolean {
  const res = queryAll(
    `SELECT
      (SELECT COUNT(*) FROM media) +
      (SELECT COUNT(*) FROM categories) +
      (SELECT COUNT(*) FROM playlists) +
      (SELECT COUNT(*) FROM recents) +
      (SELECT COUNT(*) FROM favorite_cues) AS total`,
  );
  return !res[0]?.total;
}

function saveAll(payload: {
  library: {
    categories: {
      id: string;
      name: string;
      children: any[];
      mediaIds: string[];
    }[];
    rootMediaIds: string[];
    media: Record<string, any>;
  };
  playlists: {
    id: string;
    name: string;
    createdAt: number;
    mediaIds: string[];
  }[];
  recents: {
    path: string;
    name: string;
    kind: string;
    playedAt: number;
    subtitlePath?: string;
  }[];
  favorites?: {
    id: string;
    text: string;
    sourceSubtitle: string;
    videoPath: string;
    start: number;
    end: number;
    createdAt: number;
    groupId: string | null;
  }[];
  favGroups?: { id: string; name: string }[];
}) {
  const {
    library,
    playlists,
    recents,
    favorites = [],
    favGroups = [],
  } = payload;
  run('BEGIN');
  try {
    run('DELETE FROM category_media');
    run('DELETE FROM root_media');
    run('DELETE FROM playlist_media');
    run('DELETE FROM categories');
    run('DELETE FROM playlists');
    run('DELETE FROM media');
    run('DELETE FROM recents');
    run('DELETE FROM favorite_cues');
    run('DELETE FROM favorite_groups');

    for (const m of Object.values(library.media)) {
      run(
        'INSERT INTO media (id, path, name, kind, added_at) VALUES (?, ?, ?, ?, ?)',
        [m.id, m.path, m.name, m.kind, m.addedAt],
      );
    }
    let sort = 0;
    const insertCategory = (nodes: any[], parentId: string | null) => {
      nodes.forEach((node) => {
        run(
          'INSERT INTO categories (id, parent_id, name, sort) VALUES (?, ?, ?, ?)',
          [node.id, parentId, node.name, sort++],
        );
        insertCategory(node.children || [], node.id);
      });
    };
    insertCategory(library.categories, null);

    library.rootMediaIds.forEach((id, i) => {
      run('INSERT INTO root_media (media_id, sort) VALUES (?, ?)', [id, i]);
    });
    const insertCategoryMedia = (nodes: any[]) => {
      nodes.forEach((node) => {
        node.mediaIds.forEach((mediaId: string, i: number) => {
          run(
            'INSERT INTO category_media (category_id, media_id, sort) VALUES (?, ?, ?)',
            [node.id, mediaId, i],
          );
        });
        insertCategoryMedia(node.children || []);
      });
    };
    insertCategoryMedia(library.categories);

    playlists.forEach((p, i) => {
      run(
        'INSERT INTO playlists (id, name, created_at, sort) VALUES (?, ?, ?, ?)',
        [p.id, p.name, p.createdAt, i],
      );
      p.mediaIds.forEach((mediaId, j) => {
        run(
          'INSERT INTO playlist_media (playlist_id, media_id, sort) VALUES (?, ?, ?)',
          [p.id, mediaId, j],
        );
      });
    });

    recents.forEach((r) => {
      run(
        'INSERT INTO recents (path, name, kind, played_at, subtitle_path) VALUES (?, ?, ?, ?, ?)',
        [r.path, r.name, r.kind, r.playedAt, r.subtitlePath ?? null],
      );
    });

    favGroups.forEach((g, i) => {
      run('INSERT INTO favorite_groups (id, name, sort) VALUES (?, ?, ?)', [
        g.id,
        g.name,
        i,
      ]);
    });
    favorites.forEach((f, i) => {
      run(
        'INSERT INTO favorite_cues (id, text, source_subtitle, video_path, start, end, created_at, group_id, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          f.id,
          f.text,
          f.sourceSubtitle,
          f.videoPath,
          f.start,
          f.end,
          f.createdAt,
          f.groupId ?? null,
          i,
        ],
      );
    });

    run('COMMIT');
  } catch (e) {
    run('ROLLBACK');
    throw e;
  }
  persist();
}

export function setupRepeatLibraryDb() {
  ipcMain.handle('repeatLib:load', async () => {
    try {
      await getDb();
      return {
        success: true,
        empty: isEmpty(),
        data: isEmpty() ? null : loadAll(),
      };
    } catch (e) {
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
  });
}
