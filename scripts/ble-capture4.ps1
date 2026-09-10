# BLE capture v4: connect + subscribe (Notify AND Indicate), NO handshake writes,
# log ConnectionStatus changes with timestamps, listen 90s
$ErrorActionPreference = 'Continue'

$work = Join-Path $env:TEMP 'bledump'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$csPath = Join-Path $work 'BleCap4.cs'
$exePath = Join-Path $work 'BleCap4.exe'

$cs = @'
using System;
using System.Collections.Generic;
using System.Threading;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

class BleCap4
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

    static string Ts()
    {
        return DateTime.Now.ToString("HH:mm:ss.fff");
    }

    static void Main()
    {
        ulong addr = Convert.ToUInt64("F8315506BBE9", 16);

        for (int attempt = 1; attempt <= 9; attempt++)
        {
            Console.WriteLine("[" + Ts() + "][try " + attempt + "] connecting...");
            try
            {
                var dev = WaitOp(BluetoothLEDevice.FromBluetoothAddressAsync(addr, BluetoothAddressType.Random), 15000);
                if (dev == null) { Console.WriteLine("  device-null"); Thread.Sleep(3000); continue; }
                dev.ConnectionStatusChanged += delegate(BluetoothLEDevice s2, object e2)
                {
                    Console.WriteLine("[" + Ts() + "] CONN-STATUS -> " + s2.ConnectionStatus);
                };
                Console.WriteLine("[" + Ts() + "]  dev status=" + dev.ConnectionStatus);
                var svcRes = WaitOp(dev.GetGattServicesAsync(), 15000);
                if (svcRes.Status != GattCommunicationStatus.Success) { Console.WriteLine("  services: " + svcRes.Status); Thread.Sleep(3000); continue; }

                bool allOk = true;
                foreach (var sv in svcRes.Services)
                {
                    var chRes = WaitOp(sv.GetCharacteristicsAsync(), 12000);
                    if (chRes.Status != GattCommunicationStatus.Success) continue;
                    foreach (var ch in chRes.Characteristics)
                    {
                        string u = ch.Uuid.ToString();
                        if (u.IndexOf("fb0") < 0) continue;
                        GattCharacteristic c = ch;
                        c.ValueChanged += delegate(GattCharacteristic s3, GattValueChangedEventArgs e3)
                        {
                            byte[] b = ToBytes(e3.CharacteristicValue);
                            Console.WriteLine("[" + Ts() + "] NOTIFY " + c.Uuid + " len=" + b.Length + ": " + BitConverter.ToString(b));
                        };
                        if ((c.CharacteristicProperties & GattCharacteristicProperties.Notify) != 0)
                        {
                            var st = WaitOp(c.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify), 8000);
                            Console.WriteLine("[" + Ts() + "]   SUB-N " + u + " -> " + st);
                            if (st != GattCommunicationStatus.Success) allOk = false;
                        }
                        if ((c.CharacteristicProperties & GattCharacteristicProperties.Indicate) != 0)
                        {
                            var st2 = WaitOp(c.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Indicate), 8000);
                            Console.WriteLine("[" + Ts() + "]   SUB-I " + u + " -> " + st2);
                        }
                    }
                }
                if (!allOk) { Console.WriteLine("  subscribe incomplete, retry..."); Thread.Sleep(3000); continue; }

                Console.WriteLine("[" + Ts() + "] READY - LISTENING 90s - PRESS EVERY BUTTON SLOWLY!");
                Thread.Sleep(90000);
                Console.WriteLine("[" + Ts() + "] DONE");
                return;
            }
            catch (Exception ex)
            {
                Console.WriteLine("[" + Ts() + "]  err: " + ex.Message);
                Thread.Sleep(3000);
            }
        }
        Console.WriteLine("GAVE UP");
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
