# BLE scan + connect + button capture (C# v3)
# scan adverts -> connect by advertised address -> dump GATT services -> subscribe notify -> capture button data
$ErrorActionPreference = 'Continue'

$work = Join-Path $env:TEMP 'bledump'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$csPath = Join-Path $work 'BleScan.cs'
$exePath = Join-Path $work 'BleScan.exe'

$cs = @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using Windows.Foundation;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

class BleScan
{
    static T WaitOp<T>(IAsyncOperation<T> op, int timeoutMs)
    {
        int waited = 0;
        while (op.Status == AsyncStatus.Started)
        {
            if (waited > timeoutMs) throw new Exception("timeout");
            Thread.Sleep(100);
            waited += 100;
        }
        if (op.Status == AsyncStatus.Completed) return op.GetResults();
        if (op.Status == AsyncStatus.Error && op.ErrorCode != null)
            throw new Exception("op error: " + op.ErrorCode.Message);
        throw new Exception("op status: " + op.Status);
    }

    static object seenLock = new object();
    static HashSet<ulong> seen = new HashSet<ulong>();
    static ManualResetEvent foundEvt = new ManualResetEvent(false);
    static ulong foundAddr = 0;
    static string foundName = "";

    static void OnAdvReceived(BluetoothLEAdvertisementWatcher s, BluetoothLEAdvertisementReceivedEventArgs e)
    {
        lock (seenLock)
        {
            if (!seen.Add(e.BluetoothAddress)) return;
            string nm = e.Advertisement.LocalName;
            StringBuilder svcs = new StringBuilder();
            foreach (Guid g in e.Advertisement.ServiceUuids)
            {
                if (svcs.Length > 0) svcs.Append(",");
                svcs.Append(g.ToString());
            }
            Console.WriteLine("ADV name='" + nm + "' addr=" + e.BluetoothAddress.ToString("X12") + " type=" + e.BluetoothAddressType + " rssi=" + e.RawSignalStrengthInDBm + " svcs=[" + svcs + "]");
            if (!foundEvt.WaitOne(0) && nm != null && nm.Length > 0 &&
                (nm.IndexOf("Yima", StringComparison.OrdinalIgnoreCase) >= 0 || nm.IndexOf("BHA", StringComparison.OrdinalIgnoreCase) >= 0))
            {
                foundAddr = e.BluetoothAddress;
                foundName = nm;
                foundEvt.Set();
            }
        }
    }

    static void Main()
    {
        BluetoothLEAdvertisementWatcher watcher = new BluetoothLEAdvertisementWatcher();
        watcher.ScanningMode = BluetoothLEScanningMode.Active;
        watcher.Received += OnAdvReceived;
        watcher.Start();
        Console.WriteLine("SCANNING 25s ... keep controller LED flashing");
        bool found = foundEvt.WaitOne(25000);
        watcher.Stop();
        watcher.Received -= OnAdvReceived;
        lock (seenLock) { Console.WriteLine("advert total: " + seen.Count); }
        if (!found)
        {
            Console.WriteLine("TARGET NOT FOUND");
            return;
        }
        Console.WriteLine("TARGET FOUND: " + foundName + " @ " + foundAddr.ToString("X12"));
        try
        {
            var dev = WaitOp(BluetoothLEDevice.FromBluetoothAddressAsync(foundAddr, BluetoothAddressType.Random), 20000);
            if (dev == null) { Console.WriteLine("CONNECT: device-null"); return; }
            Console.WriteLine("CONNECTED name=" + dev.Name + " status=" + dev.ConnectionStatus);
            var svcRes = WaitOp(dev.GetGattServicesAsync(), 25000);
            Console.WriteLine("SERVICES status=" + svcRes.Status + " count=" + svcRes.Services.Count);
            List<GattCharacteristic> notifyChars = new List<GattCharacteristic>();
            foreach (var sv in svcRes.Services)
            {
                Console.WriteLine("SVC: " + sv.Uuid);
                var chRes = WaitOp(sv.GetCharacteristicsAsync(), 20000);
                if (chRes.Status != GattCommunicationStatus.Success) { Console.WriteLine("  chars: " + chRes.Status); continue; }
                foreach (var ch in chRes.Characteristics)
                {
                    Console.WriteLine("  CH: " + ch.Uuid + " props=" + ch.CharacteristicProperties);
                    if ((ch.CharacteristicProperties & (GattCharacteristicProperties.Notify | GattCharacteristicProperties.Indicate)) != 0)
                        notifyChars.Add(ch);
                }
            }
            foreach (GattCharacteristic ch in notifyChars)
            {
                GattCharacteristic c = ch;
                c.ValueChanged += delegate(GattCharacteristic s2, GattValueChangedEventArgs e2)
                {
                        DataReader dr = DataReader.FromBuffer(e2.CharacteristicValue);
                        byte[] b = new byte[dr.UnconsumedBufferLength];
                        dr.ReadBytes(b);
                    Console.WriteLine("NOTIFY " + c.Uuid + ": " + BitConverter.ToString(b));
                };
                var st = WaitOp(c.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify), 10000);
                Console.WriteLine("SUBSCRIBE " + ch.Uuid + " -> " + st);
            }
            Console.WriteLine("LISTENING 40s - PRESS CONTROLLER BUTTONS NOW!");
            Thread.Sleep(40000);
            Console.WriteLine("DONE");
        }
        catch (Exception ex)
        {
            Console.WriteLine("ERROR: " + ex.Message);
        }
    }
}
'@
Set-Content -Path $csPath -Value $cs -Encoding UTF8

$winmdDir = 'C:\Windows\System32\WinMetadata'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }

# GAC 程序集路径动态解析（避免硬编码反斜杠路径被转义破坏）
$gacRefs = @(
    'System.Runtime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a',
    'System.Runtime.InteropServices.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a',
    'System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089'
) | ForEach-Object {
    try { [System.Reflection.Assembly]::Load($_).Location } catch { $null }
} | Where-Object { $_ -and (Test-Path $_) }

$refs = @(
    (Join-Path $winmdDir 'Windows.Devices.winmd'),
    (Join-Path $winmdDir 'Windows.Foundation.winmd'),
    (Join-Path $winmdDir 'Windows.Storage.winmd'),
    (Join-Path $winmdDir 'Windows.Foundation.UniversalApiContract.winmd')
) | Where-Object { Test-Path $_ }
$refs += $gacRefs

Write-Output ("refs: " + ($refs -join ' ; '))

$allArgs = @('/nologo', "/out:$exePath") + ($refs | ForEach-Object { "/r:$_" }) + @($csPath)
Write-Output 'COMPILING...'
& $csc $allArgs
if (-not (Test-Path $exePath)) { Write-Output 'COMPILE FAILED'; exit 1 }
Write-Output 'RUNNING...'
& $exePath
