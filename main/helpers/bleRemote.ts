/**
 * 蓝牙复读手柄 BLE 直连桥（如艺漫新 Yimanxin BHA02，私有 GATT 协议）。
 *
 * 手柄不是标准 HID 键盘：私有服务 0xFB00，按键事件走特征值 0xFB01 的 Notify，
 * 帧格式为「按下 = 1 字节键码（0x20..0x2D），松开 = 0x00」。
 *
 * 实现方式：首次使用时用系统自带 csc.exe 把内嵌的 C# 桥接助手编译到
 * userData/ble-helper/BleBridge.exe（WinRT BLE API 在 Node 侧无原生绑定，
 * C# 走 Windows 自带投影，零额外依赖）。助手常驻：
 *   断线重连策略（自愈）：
 *   1) 先按「上次已知地址」直连多轮——配对设备被 Windows 自动重连后不再广播，
 *      此时按地址直连仍可建立 GATT（无需广播）；
 *   2) 直连失败再按名称扫描广播（应对地址轮换/首发现）；
 *   3) 连接成功回发 ADDR 行，主进程持久化到 ble-helper/last-device.json，
 *      助手进程意外退出重启后也能拿到地址；
 *   4) 连接期间轮询 ConnectionStatus + 断链事件双保险，链路一断整套释放重试；
 *   5) 每次会话结束 Dispose 旧设备对象，避免僵尸会话阻塞新连接。
 */

import { app, ipcMain, BrowserWindow } from 'electron';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logMessage } from './storeManager';

const CHANNEL_EVENT = 'bleRemote:event';

let child: ChildProcess | null = null;
let wanted = false; // 用户意图：true = 想保持桥接运行
let restartTimer: NodeJS.Timeout | null = null;
let lastStatus = 'off';
let currentFilter = 'BHA';
let currentChar = 'fb01';
let lastAddr = ''; // 上次成功连接的设备地址（跨进程重启持久化）
// 正在运行的会话参数（用于判断「同设备已在运行」）与代际（旧进程退出事件不再触发重启）
let spawnedFilter = '';
let spawnedChar = '';
let spawnedAddr = '';
let generation = 0;

/** C# 桥接助手源码（ASCII only：csc 按本地代码页读源文件，非 ASCII 注释会被吞行） */
const CS_SOURCE = String.raw`
using System;
using System.Threading;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

class BleBridge
{
    static string nameFilter = "BHA";
    static string charFragment = "fb01";
    static string lastAddrHex = "";

    static T WaitOp<T>(Windows.Foundation.IAsyncOperation<T> op, int timeoutMs)
    {
        int waited = 0;
        while (op.Status == Windows.Foundation.AsyncStatus.Started)
        {
            if (waited > timeoutMs) throw new Exception("timeout");
            Thread.Sleep(100);
            waited += 100;
        }
        if (op.Status == Windows.Foundation.AsyncStatus.Completed) return op.GetResults();
        if (op.Status == Windows.Foundation.AsyncStatus.Error && op.ErrorCode != null)
            throw new Exception("op error: " + op.ErrorCode.Message);
        throw new Exception("op status: " + op.Status);
    }

    static byte[] ToBytes(Windows.Storage.Streams.IBuffer buf)
    {
        DataReader dr = DataReader.FromBuffer(buf);
        byte[] b = new byte[dr.UnconsumedBufferLength];
        dr.ReadBytes(b);
        return b;
    }

    static void Emit(string line)
    {
        Console.Out.WriteLine(line);
        try { Console.Out.Flush(); } catch { }
    }

    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0].Length > 0) nameFilter = args[0];
        if (args.Length > 1 && args[1].Length > 0) charFragment = args[1];
        if (args.Length > 2 && args[2].Length > 0) lastAddrHex = args[2];
        Emit("LOG boot filter=" + nameFilter + " char=" + charFragment + " last=" + lastAddrHex);
        while (true)
        {
            try { RunSession(); }
            catch (Exception ex) { Emit("LOG session-end " + ex.Message); }
            Emit("STATUS disconnected");
            Thread.Sleep(3000);
        }
    }

    static ulong TryParseAddr(string hex)
    {
        ulong v;
        if (hex != null && hex.Length > 0 &&
            ulong.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out v))
            return v;
        return 0;
    }

    static void RunSession()
    {
        ulong known = TryParseAddr(lastAddrHex);

        // 1) 按上次已知地址直连多轮：配对设备被 Windows 自动重连后不再广播，
        //    此时广播扫描扫不到，但按地址直连仍可建立 GATT
        if (known != 0)
        {
            for (int i = 1; i <= 3; i++)
            {
                Emit("LOG direct-connect try " + i);
                BluetoothLEDevice dev = WaitOp(
                    BluetoothLEDevice.FromBluetoothAddressAsync(known, BluetoothAddressType.Random),
                    12000);
                if (dev != null)
                {
                    Emit("ADDR " + dev.BluetoothAddress.ToString("X12"));
                    try
                    {
                        Session(dev);
                    }
                    finally
                    {
                        try { dev.Dispose(); } catch { }
                    }
                    return;
                }
                Emit("LOG direct try " + i + " failed");
                Thread.Sleep(2000);
            }
        }

        // 2) 按名称扫描广播（覆盖地址轮换/首发现）
        ulong scanned = FindTarget(20000);
        if (scanned == 0) throw new Exception("target not in adverts");
        Emit("ADDR " + scanned.ToString("X12"));
        var dev2 = WaitOp(
            BluetoothLEDevice.FromBluetoothAddressAsync(scanned, BluetoothAddressType.Random),
            12000);
        if (dev2 == null) throw new Exception("device null");
        try
        {
            Session(dev2);
        }
        finally
        {
            try { dev2.Dispose(); } catch { }
        }
    }

    static ulong FindTarget(int waitMs)
    {
        ManualResetEvent fnd = new ManualResetEvent(false);
        ulong found = 0;
        BluetoothLEAdvertisementWatcher w = new BluetoothLEAdvertisementWatcher();
        w.ScanningMode = BluetoothLEScanningMode.Active;
        w.Received += delegate(BluetoothLEAdvertisementWatcher s, BluetoothLEAdvertisementReceivedEventArgs e)
        {
            if (found != 0) return;
            string nm = e.Advertisement.LocalName;
            bool byName = nm != null && nm.Length > 0 &&
                nm.IndexOf(nameFilter, StringComparison.OrdinalIgnoreCase) >= 0;
            bool byAddr = lastAddrHex.Length > 0 &&
                e.BluetoothAddress.ToString("X12") == lastAddrHex;
            if (byName || byAddr)
            {
                found = e.BluetoothAddress;
                fnd.Set();
            }
        };
        w.Start();
        fnd.WaitOne(waitMs);
        w.Stop();
        return found;
    }

    static void Session(BluetoothLEDevice dev)
    {
        var svcRes = WaitOp(dev.GetGattServicesAsync(), 15000);
        if (svcRes.Status != GattCommunicationStatus.Success) throw new Exception("services " + svcRes.Status);
        GattCharacteristic button = null;
        foreach (var sv in svcRes.Services)
        {
            var chRes = WaitOp(sv.GetCharacteristicsAsync(), 12000);
            if (chRes.Status != GattCommunicationStatus.Success) continue;
            foreach (var ch in chRes.Characteristics)
            {
                string u = ch.Uuid.ToString();
                if (u.IndexOf(charFragment) >= 0 && (ch.CharacteristicProperties & GattCharacteristicProperties.Notify) != 0)
                    button = ch;
            }
        }
        if (button == null) throw new Exception(charFragment + " not found");
        var st = WaitOp(button.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify), 8000);
        if (st != GattCommunicationStatus.Success) throw new Exception("subscribe " + st);
        Emit("STATUS connected");
        ManualResetEvent lost = new ManualResetEvent(false);
        dev.ConnectionStatusChanged += delegate(BluetoothLEDevice s, object e)
        {
            try
            {
                if (s.ConnectionStatus == BluetoothConnectionStatus.Disconnected) lost.Set();
            }
            catch { }
        };
        button.ValueChanged += delegate(GattCharacteristic s2, GattValueChangedEventArgs e2)
        {
            try
            {
                byte[] b = ToBytes(e2.CharacteristicValue);
                if (b.Length == 1) Emit("CODE " + b[0].ToString("X2"));
                else Emit("CODE " + BitConverter.ToString(b));
            }
            catch { }
        };
        // 链路健康双保险：断链事件 + 轮询 ConnectionStatus
        while (!lost.WaitOne(2000))
        {
            if (dev.ConnectionStatus == BluetoothConnectionStatus.Disconnected)
            {
                lost.Set();
            }
        }
        throw new Exception("link lost");
    }
}
`;

function helperDir(): string {
  return path.join(app.getPath('userData'), 'ble-helper');
}
function helperExe(): string {
  return path.join(helperDir(), 'BleBridge.exe');
}
function lastDeviceFile(): string {
  return path.join(helperDir(), 'last-device.json');
}

/** 读取上次成功连接的设备信息（跨主进程重启持久化） */
function readLastDevice(): { addr?: string; filter?: string; char?: string } {
  try {
    return JSON.parse(fs.readFileSync(lastDeviceFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeLastDevice(patch: {
  addr?: string;
  filter?: string;
  char?: string;
}) {
  try {
    fs.mkdirSync(helperDir(), { recursive: true });
    const merged = { ...readLastDevice(), ...patch };
    fs.writeFileSync(lastDeviceFile(), JSON.stringify(merged), 'utf8');
  } catch {
    /* 忽略 */
  }
}

function broadcast(type: string, value: string) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.webContents.send(CHANNEL_EVENT, { type, value });
    } catch {
      /* 窗口可能已销毁 */
    }
  }
}

/** 首次使用时编译内嵌 C# 助手（系统自带 csc，无需 SDK） */
function ensureHelper(): boolean {
  try {
    fs.mkdirSync(helperDir(), { recursive: true });
    const cs = path.join(helperDir(), 'BleBridge.cs');
    // 源码变更检测：CS 源更新后强制重编译，避免旧 exe 一直被复用
    const csStale =
      !fs.existsSync(cs) || fs.readFileSync(cs, 'utf8') !== CS_SOURCE;
    if (fs.existsSync(helperExe()) && !csStale) return true;
    fs.writeFileSync(cs, CS_SOURCE, 'utf8');

    const windir = process.env.windir || path.join('C:', 'Windows');
    const cscCandidates = [
      path.join(
        windir,
        'Microsoft.NET',
        'Framework64',
        'v4.0.30319',
        'csc.exe',
      ),
      path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ];
    const csc = cscCandidates.find((p) => fs.existsSync(p));
    if (!csc) {
      logMessage('BLE 桥接编译失败：未找到系统 csc.exe', 'warning');
      return false;
    }
    const winmd = path.join(windir, 'System32', 'WinMetadata');
    const gac = path.join(windir, 'Microsoft.NET', 'assembly', 'GAC_MSIL');
    const refs = [
      path.join(winmd, 'Windows.Devices.winmd'),
      path.join(winmd, 'Windows.Foundation.winmd'),
      path.join(winmd, 'Windows.Storage.winmd'),
      path.join(winmd, 'Windows.Foundation.UniversalApiContract.winmd'),
      path.join(
        gac,
        'System.Runtime',
        'v4.0_4.0.0.0__b03f5f7f11d50a3a',
        'System.Runtime.dll',
      ),
      path.join(
        gac,
        'System.Runtime.InteropServices.WindowsRuntime',
        'v4.0_4.0.0.0__b03f5f7f11d50a3a',
        'System.Runtime.InteropServices.WindowsRuntime.dll',
      ),
      path.join(
        gac,
        'System.Runtime.WindowsRuntime',
        'v4.0_4.0.0.0__b77a5c561934e089',
        'System.Runtime.WindowsRuntime.dll',
      ),
    ].filter((p) => fs.existsSync(p));

    const args = [
      '/nologo',
      `/out:${helperExe()}`,
      ...refs.map((r) => `/r:${r}`),
      cs,
    ];
    const res = spawnSync(csc, args, { windowsHide: true, timeout: 60000 });
    if (!fs.existsSync(helperExe())) {
      logMessage(
        `BLE 桥接编译失败：${(res.stderr?.toString() || res.stdout?.toString() || '').slice(0, 500)}`,
        'warning',
      );
      return false;
    }
    logMessage('BLE 桥接助手编译完成', 'info');
    return true;
  } catch (e) {
    logMessage(`BLE 桥接准备失败：${(e as Error).message}`, 'warning');
    return false;
  }
}

function spawnHelper() {
  const myGen = ++generation;
  spawnedFilter = currentFilter;
  spawnedChar = currentChar;
  spawnedAddr = lastAddr;
  try {
    child = spawn(helperExe(), [currentFilter, currentChar, lastAddr], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    logMessage(`BLE 桥接启动失败：${(e as Error).message}`, 'warning');
    child = null;
    scheduleRestart();
    return;
  }
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '').trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (line.startsWith('CODE ')) {
        broadcast('code', line.slice(5));
      } else if (line.startsWith('STATUS ')) {
        lastStatus = line.slice(7);
        broadcast('status', lastStatus);
      } else if (line.startsWith('ADDR ')) {
        lastAddr = line.slice(5);
        writeLastDevice({
          addr: lastAddr,
          filter: currentFilter,
          char: currentChar,
        });
      } else if (line.startsWith('LOG ')) {
        logMessage(`BLE 桥接：${line.slice(4)}`, 'info');
      }
    }
  });
  child.stderr?.on('data', (d: Buffer) =>
    logMessage(`BLE 桥接 stderr：${d.toString().slice(0, 200)}`, 'info'),
  );
  child.on('exit', () => {
    // 切换设备时旧进程的退出事件按代际忽略，避免双进程
    if (myGen !== generation) return;
    child = null;
    broadcast('status', 'disconnected');
    lastStatus = 'disconnected';
    scheduleRestart();
  });
}

function scheduleRestart() {
  if (!wanted) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (wanted) spawnHelper();
  }, 5000);
}

function startHelper(
  nameFilter: string,
  charFragment: string,
): { success: boolean; error?: string } {
  currentFilter = nameFilter || 'BHA';
  currentChar = charFragment || 'fb01';
  if (!ensureHelper()) return { success: false, error: 'compile failed' };
  wanted = true;
  if (child) {
    if (
      spawnedFilter === currentFilter &&
      spawnedChar === currentChar &&
      spawnedAddr === lastAddr
    ) {
      return { success: true };
    }
    // 切换设备：终止旧进程（其 exit 回调因代际不匹配被忽略）
    child.kill();
    child = null;
  }
  // 内存中没有地址时，恢复上次成功连接的设备地址
  if (!lastAddr) {
    const last = readLastDevice();
    if (last.addr) lastAddr = last.addr;
  }
  spawnHelper();
  return { success: true };
}

function stopHelper() {
  wanted = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (child) {
    child.kill();
    child = null;
  }
  lastStatus = 'off';
  broadcast('status', 'off');
}

export function setupBleRemoteHandlers() {
  ipcMain.handle('bleRemote:start', (_e, { name, char }) =>
    startHelper(
      typeof name === 'string' ? name : 'BHA',
      typeof char === 'string' ? char : 'fb01',
    ),
  );
  ipcMain.handle('bleRemote:stop', () => {
    stopHelper();
    return { success: true };
  });
  ipcMain.handle('bleRemote:status', () => ({
    success: true,
    data: { status: lastStatus, running: wanted },
  }));
}
