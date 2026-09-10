# BLE 广播扫描器 v2：Register-ObjectEvent 方式注册事件（PS 5.1 WinRT 兼容写法）
# 监听 75 秒内所有低功耗蓝牙广播，结束后统一输出 设备名/MAC/广播服务UUID
$ErrorActionPreference = 'Continue'

[Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher, Windows.Devices.Bluetooth.Advertisement, ContentType = WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.Advertisement.BluetoothLEScanningMode, Windows.Devices.Bluetooth.Advertisement, ContentType = WindowsRuntime] | Out-Null

$global:seen = @{}
$watcher = New-Object Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher
if (-not $watcher) { Write-Output 'ERROR: watcher create failed'; exit 1 }
$watcher.ScanningMode = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEScanningMode]::Active

Register-ObjectEvent -InputObject $watcher -EventName 'Received' -Action {
    $e = $Event.SourceEventArgs
    $mac = '{0:X12}' -f $e.BluetoothAddress
    if ($global:seen.ContainsKey($mac)) { return }
    $svcs = ($e.Advertisement.ServiceUuids | ForEach-Object { $_.ToString() }) -join ','
    $extra = ''
    foreach ($s in $e.Advertisement.DataSections) {
        $extra += (' [type=0x{0:X} len={1}]' -f $s.DataType, $s.Data.Length)
    }
    $global:seen[$mac] = @{
        name = $e.Advertisement.LocalName
        rssi = $e.RawSignalStrengthInDBm
        svcs = $svcs
        extra = $extra
    }
} | Out-Null

$watcher.Start()
Write-Output 'SCANNING 75s...'
Start-Sleep -Seconds 75
$watcher.Stop()
Start-Sleep -Seconds 1

Write-Output ("TOTAL " + $global:seen.Count + " devices")
foreach ($mac in $global:seen.Keys) {
    $d = $global:seen[$mac]
    Write-Output ("DEV name='{0}' mac={1} rssi={2} svcs=[{3}]{4}" -f $d.name, $mac, $d.rssi, $d.svcs, $d.extra)
}
