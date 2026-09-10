# BLE capture v3: retry-connect loop (90s window) + handshake writes + 60s notify capture
$ErrorActionPreference = 'Continue'

$work = Join-Path $env:TEMP 'bledump'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$csPath = Join-Path $work 'BleCap.cs'
$exePath = Join-Path $work 'BleCap.exe'

$cs = @'
using System;
using System.Collections.Generic;
using System.Threading;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

class BleCap
{
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

    static Windows.Storage.Streams.IBuffer FromBytes(byte[] b)
    {
        DataWriter dw = new DataWriter();
        dw.WriteBytes(b);
        return dw.DetachBuffer();
    }

    static void Main()
    {
        ulong addr = Convert.ToUInt64("F8315506BBE9", 16);
        List<GattCharacteristic> notifyChars = null;
        object devLock = new object();

        for (int attempt = 1; attempt <= 9; attempt++)
        {
            Console.WriteLine("[try " + attempt + "] connecting (double-press power NOW if LED is off)...");
            try
            {
                var dev = WaitOp(BluetoothLEDevice.FromBluetoothAddressAsync(addr, BluetoothAddressType.Random), 15000);
                if (dev == null) { Console.WriteLine("  device-null"); Thread.Sleep(3000); continue; }
                Console.WriteLine("  dev status=" + dev.ConnectionStatus);
                var svcRes = WaitOp(dev.GetGattServicesAsync(), 15000);
                if (svcRes.Status != GattCommunicationStatus.Success) { Console.WriteLine("  services: " + svcRes.Status); Thread.Sleep(3000); continue; }
                List<GattCharacteristic> nc = new List<GattCharacteristic>();
                GattCharacteristic hs1 = null, hs4 = null;
                foreach (var sv in svcRes.Services)
                {
                    var chRes = WaitOp(sv.GetCharacteristicsAsync(), 12000);
                    if (chRes.Status != GattCommunicationStatus.Success) continue;
                    foreach (var ch in chRes.Characteristics)
                    {
                        string u = ch.Uuid.ToString();
                        if (u.IndexOf("fb0") < 0) continue;
                        if ((ch.CharacteristicProperties & (GattCharacteristicProperties.Notify | GattCharacteristicProperties.Indicate)) != 0)
                            nc.Add(ch);
                        if (u.IndexOf("fb01") >= 0) hs1 = ch;
                        if (u.IndexOf("fb04") >= 0) hs4 = ch;
                    }
                }
                bool allOk = nc.Count >= 3;
                foreach (var ch in nc)
                {
                    GattCharacteristic c = ch;
                    c.ValueChanged += delegate(GattCharacteristic s2, GattValueChangedEventArgs e2)
                    {
                        byte[] b = ToBytes(e2.CharacteristicValue);
                        Console.WriteLine("NOTIFY " + c.Uuid + " len=" + b.Length + ": " + BitConverter.ToString(b) + "  @ms=" + Environment.TickCount);
                    };
                    var st = WaitOp(c.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify), 8000);
                    Console.WriteLine("  SUBSCRIBE " + ch.Uuid + " -> " + st);
                    if (st != GattCommunicationStatus.Success) allOk = false;
                }
                if (!allOk) { Console.WriteLine("  subscribe incomplete, retrying..."); Thread.Sleep(3000); continue; }

                // handshake attempts (vendor protocols usually need an enable write)
                byte[][] probes = new byte[][] { new byte[] { 0x01 }, new byte[] { 0xA5, 0x01 }, new byte[] { 0x00 } };
                foreach (byte[] p in probes)
                {
                    try
                    {
                        if (hs4 != null)
                        {
                            var st = WaitOp(hs4.WriteValueWithResultAsync(FromBytes((byte[])p.Clone())), 5000);
                            Console.WriteLine("  HS->FB04 " + BitConverter.ToString(p) + " -> " + st.Status);
                        }
                        if (hs1 != null)
                        {
                            var st2 = WaitOp(hs1.WriteValueWithResultAsync(FromBytes((byte[])p.Clone())), 5000);
                            Console.WriteLine("  HS->FB01 " + BitConverter.ToString(p) + " -> " + st2.Status);
                        }
                    }
                    catch (Exception ex) { Console.WriteLine("  HS err: " + ex.Message); }
                    Thread.Sleep(800);
                }

                Console.WriteLine("CONNECTED+SUBSCRIBED. LISTENING 75s - PRESS EVERY BUTTON SLOWLY, ONE BY ONE!");
                Thread.Sleep(75000);
                Console.WriteLine("DONE");
                return;
            }
            catch (Exception ex)
            {
                Console.WriteLine("  err: " + ex.Message);
                Thread.Sleep(3000);
            }
        }
        Console.WriteLine("GAVE UP (no live connection in 9 tries)");
    }
}
'@
Set-Content -Path $csPath -Value $cs -Encoding UTF8

$winmdDir = 'C:\Windows\System32\WinMetadata'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }

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

$allArgs = @('/nologo', "/out:$exePath") + ($refs | ForEach-Object { "/r:$_" }) + @($csPath)
Write-Output 'COMPILING...'
& $csc $allArgs
if (-not (Test-Path $exePath)) { Write-Output 'COMPILE FAILED'; exit 1 }
Write-Output 'RUNNING...'
& $exePath
