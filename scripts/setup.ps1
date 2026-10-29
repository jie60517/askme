# 開發版一鍵安裝(Windows)。在 repo 根目錄打 .\setup.cmd。
#
# 做的事就是 README「手動安裝」那幾步:後端 .venv + 套件、backend\.env、前端 npm install。
# 重跑沒關係:已經有的 .venv 與 .env 不會被蓋掉(.env 可能已經改過帳密)。
#
# ⚠️ 這個檔要存成 **UTF-8 with BOM**:Windows PowerShell 5.1 讀沒有 BOM 的檔會當成
# 系統碼頁,中文訊息會變亂碼、字串引號還可能被吃掉而整支 parse 失敗。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$venvPy = Join-Path $backend '.venv\Scripts\python.exe'

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "`n[失敗] $msg" -ForegroundColor Red; exit 1 }

Step '1/6 檢查 Python、Node、claude'
# `python` 可能是 Windows 市集的空殼(WindowsApps\python.exe):不印版本、只開市集,所以看輸出不看有沒有這個指令
$pyVer = ''
try { $pyVer = (& python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null) } catch {}
if (-not $pyVer) { Fail '找不到 Python。請先裝 Python 3.11 以上(安裝時勾 Add python.exe to PATH),再重開 PowerShell。' }
$pyMajor, $pyMinor = $pyVer.Trim().Split('.') | ForEach-Object { [int]$_ }
if ($pyMajor -lt 3 -or ($pyMajor -eq 3 -and $pyMinor -lt 11)) { Fail "Python 是 $pyVer,需要 3.11 以上。" }
Ok "Python $pyVer"

$nodeVer = ''
try { $nodeVer = (& node -v 2>$null) } catch {}
if (-not $nodeVer) { Fail '找不到 Node.js。請先裝 Node 22.12 以上(或 20.19 以上),再重開 PowerShell。' }
$nMajor, $nMinor = $nodeVer.TrimStart('v').Split('.')[0..1] | ForEach-Object { [int]$_ }
# vite 的要求:^20.19.0 || >=22.12.0(21 不行)
$nodeOk = ($nMajor -eq 20 -and $nMinor -ge 19) -or ($nMajor -eq 22 -and $nMinor -ge 12) -or ($nMajor -ge 23)
if (-not $nodeOk) { Fail "Node 是 $nodeVer,需要 22.12 以上(或 20.19 以上)。" }
Ok "Node $nodeVer"

if (Get-Command claude -ErrorAction SilentlyContinue) {
    Ok 'claude CLI'
} else {
    # 不擋:沒有 claude 網頁照樣開得起來,只是問答會回「無法啟動 claude CLI」
    Write-Host '   !!  找不到 claude CLI。網站照樣裝得起來,但問答要等你裝好 Claude Code 並登入過一次。' -ForegroundColor Yellow
}

Step '2/6 建立後端虛擬環境 backend\.venv'
if (Test-Path $venvPy) {
    Ok '已經有了,略過'
} else {
    & python -m venv (Join-Path $backend '.venv')
    if ($LASTEXITCODE -ne 0) { Fail '建立虛擬環境失敗,看上面的訊息。' }
    Ok '建好了'
}

Step '3/6 安裝後端套件(第一次約 1~2 分鐘)'
& $venvPy -m pip install --disable-pip-version-check -r (Join-Path $backend 'requirements-dev.txt')
if ($LASTEXITCODE -ne 0) { Fail '後端套件安裝失敗,看上面的訊息(通常是網路或 Python 版本)。' }
Ok '後端套件裝好了'

Step '4/6 建立後端設定檔 backend\.env'
$envFile = Join-Path $backend '.env'
if (Test-Path $envFile) {
    Ok '已經有了,不覆蓋'
} else {
    Copy-Item (Join-Path $backend '.env.example') $envFile
    Ok '從 .env.example 複製(管理員帳密 tiptop / tiptop)'
}

Step '5/6 安裝前端套件(第一次約 1 分鐘)'
Push-Location $frontend
try {
    # 要叫 npm.cmd,不是 npm:後者會解析成 npm.ps1,它從 $MyInvocation.Line 切參數,
    # 在腳本裡用 & 叫會切錯(報「Unknown command: "pm"」)
    & npm.cmd install --no-fund
    if ($LASTEXITCODE -ne 0) { Fail '前端套件安裝失敗,看上面的訊息。' }
} finally {
    Pop-Location
}
Ok '前端套件裝好了'
Write-Host '   (上面若有「N vulnerabilities」是套件的已知漏洞提醒,不影響啟動;不要跑 npm audit fix,它會改掉 package-lock.json。)' -ForegroundColor DarkGray

Step '6/6 讀 PDF 的工具 Poppler'
. (Join-Path $PSScriptRoot 'poppler.ps1')
$popplerBin = Find-PopplerBin
if (-not $popplerBin -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    & winget install --id $PopplerWingetId -e --source winget --accept-package-agreements --accept-source-agreements
    $popplerBin = Find-PopplerBin
}
if ($popplerBin) {
    Ok "Poppler($popplerBin)"
} else {
    # 不擋:少了它網站照樣能用,只是問答讀不了大份的 PDF
    Write-Host "   !!  沒裝成 Poppler。網站照樣能用,但問答讀不了大份的 PDF。可以自己裝:winget install --id $PopplerWingetId -e,裝完重開 start.cmd。" -ForegroundColor Yellow
}

$ws = Join-Path $root 'workspace'
Write-Host ''
Write-Host '安裝完成。接下來:' -ForegroundColor Green
Write-Host "  1. 把你的專案資料夾整個放進 $ws\"
Write-Host "     例:$ws\toptest\tiptop\aap\4gl\...(workspace 底下第一層的每個資料夾 = 一個專案)"
Write-Host '  2. 啟動:.\start.cmd   (會自己開瀏覽器到 http://localhost:5173)'
Write-Host '  3. 登入:tiptop / tiptop(backend\.env 的 ADMIN_USERNAME / ADMIN_PASSWORD)'
