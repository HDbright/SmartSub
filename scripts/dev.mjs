// dev 端口自愈启动器。
// 背景：Windows 的 Hyper-V/WinNAT 会动态保留大段 TCP 端口
// （`netsh int ipv4 show excludedportrange protocol=tcp` 可见），且区间随重启漂移，
// nextron 默认的 8888 常落进保留段导致 `listen EACCES` 启动失败。
// 注意：不能直接用 net.createServer 试绑来探测——libuv 在 Windows 上默认
// SO_REUSEADDR，对已被监听的端口也会"绑定成功"，得出假阳性。
// 因此这里解析两份系统事实：① netsh 的排除端口区间 ② netstat 的监听端口，
// 候选端口避开两者后再启动 nextron。
import { execSync, spawn } from 'node:child_process';

// 8888 优先：与历史 localStorage 数据的 origin 保持一致
const CANDIDATES = [8888, 9300, 9291, 9422, 3100, 5173, 8080, 3000];

function execText(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Windows 排除端口区间（Hyper-V/WinNAT 动态保留，绑定会 EACCES） */
function excludedRanges() {
  const out = execText('netsh int ipv4 show excludedportrange protocol=tcp');
  const ranges = [];
  for (const m of out.matchAll(/(\d{2,5})\s+(\d{2,5})/g)) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (hi > lo && hi < 65536) ranges.push([lo, hi]);
  }
  return ranges;
}

/** 已被监听的端口（netstat；解析数字即可，与系统语言无关） */
function listeningPorts() {
  const out = execText('netstat -ano -p tcp');
  const ports = new Set();
  for (const m of out.matchAll(/^\s*(?:tcp|TCP)\s+\S*?(\d{2,5})\s+\S+\s+LISTENING/gim)) {
    ports.add(Number(m[1]));
  }
  return ports;
}

function pickPort(candidates, ranges, used) {
  for (const port of candidates) {
    if (used.has(port)) continue;
    if (ranges.some(([lo, hi]) => port >= lo && port <= hi)) continue;
    return port;
  }
  return null;
}

const port = pickPort(CANDIDATES, excludedRanges(), listeningPorts());
if (!port) {
  console.error('[dev] 候选端口均被系统保留或占用，请检查防火墙或端口保留设置');
  console.error('[dev] 可运行 `netsh int ipv4 show excludedportrange protocol=tcp` 查看保留区间');
  process.exit(1);
}
console.log(`[dev] renderer port = ${port}`);

const child = spawn(`npx nextron dev --renderer-port ${port}`, {
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 0));
