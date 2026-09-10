/**
 * 蓝牙复读手柄 BLE 直连桥（如艺漫新 Yimanxin BHA02，私有 GATT 协议）。
 *
 * 手柄不是标准 HID 键盘：私有服务 0xFB00，按键事件走特征值 0xFB01 的 Notify，
 * 帧格式为「按下 = 1 字节键码（0x20..0x2D），松开 = 0x00」。
 *
 * 实现方式：首次使用时用系统自带 csc.exe 把内嵌的 C# 桥接助手编译到
 * userData/ble-helper/BleBridge.exe（WinRT BLE API 在 Node 侧无原生绑定，
 * C# 走 Windows 自带投影，零额外依赖）。助手常驻：广播扫描定位手柄 →
 * Random 地址直连 → 订阅 FB01 → 把键码逐行打到 stdout；主进程解析后经
 * webContents 广播给渲染层（bleRemote:event），断链自动重试，进程退出自动重启。
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
    static ulong target = 0;
    static string nameFilter = "BHA";

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
        Emit("LOG boot filter=" + nameFilter);
        while (true)
        {
            try { RunSession(); }
            catch (Exception ex) { Emit("LOG session-end " + ex.Message); }
            Emit("STATUS disconnected");
            Thread.Sleep(3000);
        }
    }

    static void RunSession()
    {
        ulong addr = FindTarget(25000);
        if (addr == 0) throw new Exception("target not in adverts");
        Emit("LOG target " + addr.ToString("X12"));
        var dev = WaitOp(BluetoothLEDevice.FromBluetoothAddressAsync(addr, BluetoothAddressType.Random), 15000);
        if (dev == null) throw new Exception("device null");
        ManualResetEvent lost = new ManualResetEvent(false);
        dev.ConnectionStatusChanged += delegate(BluetoothLEDevice s, object e)
        {
            if (s.ConnectionStatus == BluetoothConnectionStatus.Disconnected) lost.Set();
        };
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
                if (u.IndexOf("fb01") >= 0 && (ch.CharacteristicProperties & GattCharacteristicProperties.Notify) != 0)
                    button = ch;
            }
        }
        if (button == null) throw new Exception("fb01 not found");
        var st = WaitOp(button.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify), 8000);
        if (st != GattCommunicationStatus.Success) throw new Exception("subscribe " + st);
        Emit("STATUS connected");
        button.ValueChanged += delegate(GattCharacteristic s2, GattValueChangedEventArgs e2)
        {
            byte[] b = ToBytes(e2.CharacteristicValue);
            if (b.Length == 1) Emit("CODE " + b[0].ToString("X2"));
            else Emit("CODE " + BitConverter.ToString(b));
        };
        while (!lost.WaitOne(2000)) { }
        throw new Exception("link lost");
    }

    static ulong FindTarget(int waitMs)
    {
        if (target != 0) return target;
        ManualResetEvent fnd = new ManualResetEvent(false);
        BluetoothLEAdvertisementWatcher w = new BluetoothLEAdvertisementWatcher();
        w.ScanningMode = BluetoothLEScanningMode.Active;
        w.Received += delegate(BluetoothLEAdvertisementWatcher s, BluetoothLEAdvertisementReceivedEventArgs e)
        {
            string nm = e.Advertisement.LocalName;
            if (nm != null && nm.Length > 0 && nm.IndexOf(nameFilter, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                target = e.BluetoothAddress;
                fnd.Set();
            }
        };
        w.Start();
        fnd.WaitOne(waitMs);
        w.Stop();
        return target;
    }
}
`;

function helperDir(): string {
  return path.join(app.getPath('userData'), 'ble-helper');
}
function helperExe(): string {
  return path.join(helperDir(), 'BleBridge.exe');
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
  if (fs.existsSync(helperExe())) return true;
  try {
    fs.mkdirSync(helperDir(), { recursive: true });
    const cs = path.join(helperDir(), 'BleBridge.cs');
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

function spawnHelper(nameFilter: string) {
  try {
    child = spawn(helperExe(), [nameFilter], {
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
      } else if (line.startsWith('LOG ')) {
        logMessage(`BLE 桥接：${line.slice(4)}`, 'info');
      }
    }
  });
  child.stderr?.on('data', (d: Buffer) =>
    logMessage(`BLE 桥接 stderr：${d.toString().slice(0, 200)}`, 'info'),
  );
  child.on('exit', () => {
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
    if (wanted) spawnHelper(currentFilter);
  }, 5000);
}

function startHelper(nameFilter: string): { success: boolean; error?: string } {
  currentFilter = nameFilter || 'BHA';
  if (child) return { success: true };
  if (!ensureHelper()) return { success: false, error: 'compile failed' };
  wanted = true;
  spawnHelper(currentFilter);
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
  ipcMain.handle('bleRemote:start', (_e, { name }) =>
    startHelper(typeof name === 'string' ? name : 'BHA'),
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
