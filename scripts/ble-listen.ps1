# BLE listen (direct connect by known address, 60s capture)
# connect Yimanxin BHA02 @ F8315506BBE9 (Random) -> read FB05/FB04 -> subscribe FB01/FB02/FB03 -> capture 60s
$ErrorActionPreference = 'Continue'

$work = Join-Path $env:TEMP 'bledump'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$csPath = Join-Path $work 'BleListen.cs'
$exePath = Join-Path $work 'BleListen.exe'

$cs = @'
using System;
using System.Collections.Generic;
using System.Threading;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

class BleListen
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

    static string Hex(Windows.Storage.Streams.IBuffer buf)
    {
        DataReader dr = DataReader.FromBuffer(buf);
        byte[] b = new byte[dr.UnconsumedBufferLength];
        dr.ReadBytes(b);
        return BitConverter.ToString(b);
    }

    static void Main()
    {
        ulong addr = Convert.ToUInt64("F8315506BBE9", 16);
        Console.WriteLine("connecting...");
        var dev = WaitOp(BluetoothLEDevice.FromBluetoothAddressAsync(addr, BluetoothAddressType.Random), 20000);
        if (dev == null) { Console.WriteLine("device-null (need re-advertise: double-press power)"); return; }
        Console.WriteLine("connected: " + dev.Name + " status=" + dev.ConnectionStatus);
        var svcRes = WaitOp(dev.GetGattServicesAsync(), 25000);
        if (svcRes.Status != GattCommunicationStatus.Success) { Console.WriteLine("services: " + svcRes.Status); return; }
        List<GattCharacteristic> notifyChars = new List<GattCharacteristic>();
        foreach (var sv in svcRes.Services)
        {
            var chRes = WaitOp(sv.GetCharacteristicsAsync(), 20000);
            if (chRes.Status != GattCommunicationStatus.Success) continue;
            foreach (var ch in chRes.Characteristics)
            {
                Console.WriteLine("CH " + ch.Uuid + " props=" + ch.CharacteristicProperties);
                // read current value of FB05 / FB04 / 2a00
                string u = ch.Uuid.ToString();
                if ((ch.CharacteristicProperties & GattCharacteristicProperties.Read) != 0 &&
                    (u.IndexOf("fb05") >= 0 || u.IndexOf("fb04") >= 0 || u.IndexOf("2a00") >= 0))
                {
                    try
                    {
                        var rRes = WaitOp(ch.ReadValueAsync(), 8000);
                        if (rRes.Status == GattCommunicationStatus.Success)
                        {
                            string txt = "";
                            try
                            {
                                DataReader dr2 = DataReader.FromBuffer(rRes.Value);
                                byte[] bb = new byte[dr2.UnconsumedBufferLength];
                                dr2.ReadBytes(bb);
                                txt = System.Text.Encoding.UTF8.GetString(bb);
                            }
                            catch { }
                            Console.WriteLine("  READ " + u + " = " + Hex(rRes.Value) + " text='" + txt + "'");
                        }
                    }
                    catch (Exception ex) { Console.WriteLine("  read " + u + " err: " + ex.Message); }
                }
                if ((ch.CharacteristicProperties & (GattCharacteristicProperties.Notify | GattCharacteristicProperties.Indicate)) != 0)
                    notifyChars.Add(ch);
            }
        }
        foreach (GattCharacteristic ch in notifyChars)
        {
            GattCharacteristic c = ch;
            c.ValueChanged += delegate(GattCharacteristic s2, GattValueChangedEventArgs e2)
            {
                Console.WriteLine("NOTIFY " + c.Uuid + " len=" + e2.CharacteristicValue.Length + ": " + Hex(e2.CharacteristicValue));
            };
            var st = WaitOp(c.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.Notify), 10000);
            Console.WriteLine("SUBSCRIBE " + ch.Uuid + " -> " + st);
        }
        Console.WriteLine("LISTENING 60s - PRESS EVERY BUTTON ON THE CONTROLLER, ONE BY ONE!");
        Thread.Sleep(60000);
        Console.WriteLine("DONE");
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

