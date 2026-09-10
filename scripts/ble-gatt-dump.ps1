# 通过 csc.exe 直接编译引用 WinMD 的 C# 助手，直连已配对 BLE 手柄并枚举 GATT 服务/特征值
# 前提：手柄处于广播状态（双击开机键绿灯闪烁）
$ErrorActionPreference = 'Continue'

$work = Join-Path $env:TEMP 'bledump'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$csPath = Join-Path $work 'BleDump.cs'
$dllPath = Join-Path $work 'BleDump.dll'

$cs = @'
using System;
using System.Text;
using Windows.Foundation;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;

public class BleDump
{
    static T WaitOp<T>(IAsyncOperation<T> op, int timeoutMs)
    {
        int waited = 0;
        while (op.Status == AsyncStatus.Started)
        {
            if (waited > timeoutMs) throw new Exception("operation timeout");
            System.Threading.Thread.Sleep(100);
            waited += 100;
        }
        if (op.Status == AsyncStatus.Completed) return op.GetResults();
        if (op.Status == AsyncStatus.Error && op.ErrorCode != null)
            throw new Exception("op error: " + op.ErrorCode.Message);
        throw new Exception("op status: " + op.Status);
    }

    public static string Dump(string addrHex)
    {
        var sb = new StringBuilder();
        ulong addr = Convert.ToUInt64(addrHex, 16);
        var device = WaitOp(BluetoothLEDevice.FromBluetoothAddressAsync(addr, Windows.Devices.Bluetooth.BluetoothAddressType.Random), 20000);
        if (device == null) return "RESULT: device-null (shou bing wei guangbo)";
        sb.AppendLine("Device: " + device.Name + " status=" + device.ConnectionStatus);

        var svcRes = WaitOp(device.GetGattServicesAsync(), 25000);
        sb.AppendLine("GattServices status=" + svcRes.Status + " count=" + svcRes.Services.Count);
        foreach (var s in svcRes.Services)
        {
            sb.AppendLine("SVC: " + s.Uuid);
            var chRes = WaitOp(s.GetCharacteristicsAsync(), 20000);
            if (chRes.Status != GattCommunicationStatus.Success)
            {
                sb.AppendLine("  chars status=" + chRes.Status);
                continue;
            }
            foreach (var c in chRes.Characteristics)
            {
                sb.AppendLine("  CH: " + c.Uuid + " props=" + c.CharacteristicProperties);
            }
        }
        sb.AppendLine("DONE");
        return sb.ToString();
    }
}
'@
Set-Content -Path $csPath -Value $cs -Encoding UTF8

$winmdDir = 'C:\Windows\System32\WinMetadata'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }

$refs = @(
    (Join-Path $winmdDir 'Windows.Devices.winmd'),
    (Join-Path $winmdDir 'Windows.Foundation.winmd'),
    (Join-Path $winmdDir 'Windows.Foundation.UniversalApiContract.winmd'),
    'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Runtime\v4.0_4.0.0.0__b03f5f7f11d50a3a\System.Runtime.dll',
    'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Runtime.WindowsRuntime\v4.0_4.0.0.0__b77a5c561934e089\System.Runtime.WindowsRuntime.dll'
) | Where-Object { Test-Path $_ }

$args = @('/nologo', '/t:library', "/out:$dllPath")
foreach ($r in $refs) { $args += "/r:$r" }
$args += $csPath

Write-Output 'COMPILING...'
& $csc $args
if (-not (Test-Path $dllPath)) { Write-Output 'COMPILE FAILED'; exit 1 }
Write-Output 'COMPILED OK'

$asm = [System.Reflection.Assembly]::LoadFrom($dllPath)
$t = $asm.GetType('BleDump')
$done = $false
foreach ($i in 1..3) {
    try {
        $t.GetMethod('Dump').Invoke($null, @('F8315506BBE9')) | Write-Output
        $done = $true
        break
    } catch {
        $in = $_.Exception.InnerException
        Write-Output ("TRY ${i} FAILED: " + $(if ($in) { $in.Message } else { $_.Exception.Message }))
        Start-Sleep -Seconds 2
    }
}
if (-not $done) { Write-Output 'ALL RETRIES FAILED - double-press power to re-advertise, then rerun' }


