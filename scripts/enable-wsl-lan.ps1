#Requires -RunAsAdministrator
param(
    [Parameter(Mandatory = $true)][ipaddress]$ListenAddress,
    [Parameter(Mandatory = $true)][ipaddress]$WslAddress,
    [ValidateRange(1, 65535)][int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
if ($ListenAddress.AddressFamily -ne 'InterNetwork' -or $WslAddress.AddressFamily -ne 'InterNetwork') {
    throw 'Use IPv4 addresses for the laptop and WSL.'
}
$adapter = Get-NetIPAddress -IPAddress $ListenAddress.IPAddressToString -AddressFamily IPv4
$profile = Get-NetConnectionProfile -InterfaceIndex $adapter.InterfaceIndex
if ($profile.NetworkCategory -ne 'Private') {
    throw 'Set your trusted home network to Private in Windows Settings, then run this script again.'
}

# Forward only this laptop address/port. Leave localhost available for host sign-in.
& netsh interface portproxy add v4tov4 listenaddress=$ListenAddress listenport=$Port connectaddress=$WslAddress connectport=$Port
if ($LASTEXITCODE -ne 0) { throw 'Windows could not create the port forwarding rule.' }
$ruleName = "GatherRPG-LAN-$Port"
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -Name $ruleName
}
New-NetFirewallRule -Name $ruleName -DisplayName "Gather RPG local network ($Port)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $ListenAddress.IPAddressToString -RemoteAddress LocalSubnet -Profile Private | Out-Null
Write-Host "Phones on the same network can open http://${ListenAddress}:$Port"
Write-Host 'If the laptop or WSL address changes after restarting, rerun with the new addresses.'
