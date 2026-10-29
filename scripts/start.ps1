# 開發版一鍵啟動(Windows)。在 repo 根目錄打 .\start.cmd。
#
# 同一個視窗裡起後端(uvicorn)與前端(vite),兩邊的 log 都印在這裡;
# 前端好了就開瀏覽器。按 Ctrl+C 或關掉這個視窗,兩個一起停。
#
#   .\start.cmd                                    # 後端 8123、前端 5173
#   .\start.cmd -BackendPort 8124 -FrontendPort 5174   # 那兩個埠被別的東西佔了的時候
#   .\start.cmd -NoBrowser                         # 不要自動開瀏覽器
#
# ⚠️ 後端**不加 --reload**:Windows 上 uvicorn 的 reloader 會把 event loop 換成
# WindowsSelectorEventLoop,asyncio.create_subprocess_exec 在那上面是 NotImplementedError,
# 問答整個跑不起來。改了後端程式碼就 Ctrl+C 再啟動一次。
#
# ⚠️ 這個檔要存成 **UTF-8 with BOM**(理由見 setup.ps1 開頭)。

param(
    [int]$BackendPort = 8123,
    [int]$FrontendPort = 5173,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$venvPy = Join-Path $backend '.venv\Scripts\python.exe'

function Fail($msg) { Write-Host "`n[無法啟動] $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $venvPy) -or -not (Test-Path (Join-Path $frontend 'node_modules'))) {
    Fail '還沒安裝。先在 repo 根目錄跑 .\setup.cmd。'
}
if (-not (Test-Path (Join-Path $backend '.env'))) {
    Fail '少了 backend\.env。跑一次 .\setup.cmd 會從 .env.example 複製一份。'
}
foreach ($port in $BackendPort, $FrontendPort) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        Fail "埠 $port 已經有程式在用(可能是另一個已經開著的 start.cmd)。關掉它,或換埠:.\start.cmd -BackendPort 8124 -FrontendPort 5174"
    }
}

# claude 的 Read 讀 PDF 要 PATH 上有 pdftoppm(見 poppler.ps1)。只加在這個視窗,後端與它叫的 claude 會繼承
. (Join-Path $PSScriptRoot 'poppler.ps1')
$popplerBin = Find-PopplerBin
if ($popplerBin) {
    $env:Path = "$popplerBin;$env:Path"
} else {
    Write-Host '注意:找不到 Poppler(pdftoppm),問答讀不了大份的 PDF。跑一次 .\setup.cmd 會幫你裝。' -ForegroundColor Yellow
}

function Wait-Http($url, $proc, $seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if ($proc.HasExited) { return $false }
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2 | Out-Null
            return $true
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    return $false
}

# 用 -NoNewWindow 掛在同一個主控台:Ctrl+C 會同時送到兩個子行程
$be = $null
$fe = $null
try {
    Write-Host "啟動後端 http://127.0.0.1:$BackendPort(這是 API,不是網頁,不用開它)..." -ForegroundColor Cyan
    $be = Start-Process -FilePath $venvPy -ArgumentList '-m', 'uvicorn', 'app.main:app', '--port', "$BackendPort" `
        -WorkingDirectory $backend -NoNewWindow -PassThru
    if (-not (Wait-Http "http://127.0.0.1:$BackendPort/api/health" $be 60)) {
        Fail '後端沒有起來,看上面的訊息。'
    }

    Write-Host "啟動前端 http://localhost:$FrontendPort ..." -ForegroundColor Cyan
    # vite.config.ts 讀 PORT 與 API_TARGET:前端埠,與 /api 要轉去的後端
    $env:PORT = "$FrontendPort"
    $env:API_TARGET = "http://127.0.0.1:$BackendPort"
    # 等於 npm run dev,但直接叫 node:npm.cmd 是批次檔,Ctrl+C 時會多問一次「終止批次工作嗎 (Y/N)?」
    $fe = Start-Process -FilePath 'node' -ArgumentList 'node_modules/vite/bin/vite.js' -WorkingDirectory $frontend -NoNewWindow -PassThru
    if (-not (Wait-Http "http://localhost:$FrontendPort/" $fe 60)) {
        Fail '前端沒有起來,看上面的訊息。'
    }

    Write-Host ''
    Write-Host "好了。打開 http://localhost:$FrontendPort ,用 backend\.env 的 ADMIN_USERNAME / ADMIN_PASSWORD 登入(預設 tiptop / tiptop)。" -ForegroundColor Green
    Write-Host '這個視窗不要關;要停就按 Ctrl+C。' -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process "http://localhost:$FrontendPort" }

    while (-not $be.HasExited -and -not $fe.HasExited) { Start-Sleep -Seconds 1 }
    if ($be.HasExited) { Write-Host '後端停了,看上面的訊息。' -ForegroundColor Red }
    if ($fe.HasExited) { Write-Host '前端停了,看上面的訊息。' -ForegroundColor Red }
} finally {
    # Ctrl+C、關視窗、或其中一邊掛掉,都把另一邊一起收掉(連子行程:vite 底下還有 esbuild)。
    # 走 cmd 的 >nul:PowerShell 5.1 在 Stop 模式下把原生程式的 stderr 轉向會變成例外
    foreach ($p in $fe, $be) {
        if ($p -and -not $p.HasExited) { & cmd.exe /c "taskkill /T /F /PID $($p.Id) >nul 2>&1" }
    }
}
