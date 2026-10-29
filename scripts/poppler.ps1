# 讀 PDF 要用的 Poppler(setup.ps1 與 start.ps1 共用,用 . 載入)。
#
# claude 的 Read(2.1.290 實測):沒有 Poppler 時只能把整份 PDF 直接送出去,小份的讀得到;
# 大份的手冊、或指定頁數讀,要叫 PATH 上的 pdftoppm 把頁面轉成圖,找不到就回
# 「pdftoppm is not installed」。有了 Poppler 之後超過 10 頁的 PDF 一律改成分頁、看圖讀。
#
# winget 的 Poppler 是免安裝版(zip),解在 WinGet\Packages 底下:裝完不一定在 PATH 上,
# 就算在,已經開著的視窗也要重開才看得到。所以不靠 PATH,直接去那裡找。
#
# ⚠️ 這個檔要存成 **UTF-8 with BOM**(理由見 setup.ps1 開頭)。

$PopplerWingetId = 'oschwartz10612.Poppler'

# 回傳 pdftoppm.exe 所在的資料夾;找不到回 $null
function Find-PopplerBin {
    $cmd = Get-Command pdftoppm -ErrorAction SilentlyContinue
    if ($cmd) { return Split-Path -Parent $cmd.Source }
    $pkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (-not (Test-Path $pkgs)) { return $null }
    $exe = Get-ChildItem $pkgs -Directory -Filter "$PopplerWingetId*" -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Recurse -Filter pdftoppm.exe -ErrorAction SilentlyContinue } |
        Select-Object -First 1
    if ($exe) { return $exe.DirectoryName }
    return $null
}
