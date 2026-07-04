<#
.SYNOPSIS
  主题打包脚本：将当前目录下的主题打包为 .vst 分发包
.DESCRIPTION
  扫描脚本所在目录下的所有主题目录，读取 config.json 中的 packageName，
  将主题文件打包为 {packageName}.vst (ZIP) 输出到指定目录。
  自动校验打包完整性并生成汇总报告。
.PARAMETER ThemeName
  可选的目录名关键字过滤，仅打包目录名含此关键字的主题
.PARAMETER OutputDir
  输出目录，默认为脚本所在目录
.EXAMPLE
  .\pack-themes.ps1                           # 打包所有主题到本目录
  .\pack-themes.ps1 -ThemeName dark           # 仅打包目录名含 dark 的主题
  .\pack-themes.ps1 -OutputDir D:\output      # 输出到指定目录
#>
param(
    [string]$ThemeName,
    [string]$OutputDir
)

# --- 路径配置 ---
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceDir   = $ScriptDir
$OutputRoot  = if ($OutputDir) { $OutputDir } else { $ScriptDir }

# --- 确保输出目录存在 ---
if (-not (Test-Path $OutputRoot)) {
    New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
}

# --- 提前加载 ZIP 程序集 ---
Add-Type -AssemblyName System.IO.Compression.FileSystem

# --- 校验源目录 ---
if (-not (Test-Path $SourceDir)) {
    Write-Error "源主题目录不存在: $SourceDir"
    exit 1
}

# --- 收集主题目录 ---
$ThemeDirs = Get-ChildItem -Path $SourceDir -Directory
if ($ThemeName) {
    $ThemeDirs = $ThemeDirs | Where-Object { $_.Name -like "*$ThemeName*" }
}

if ($ThemeDirs.Count -eq 0) {
    Write-Warning "未找到匹配的主题"
    exit 0
}

# --- 需要包含的文件扩展名 ---
$IncludeExtensions = @('.json', '.css', '.js', '.png', '.svg')

Write-Host "=== ViewPDF 主题打包工具 ===" -ForegroundColor Cyan
Write-Host "源目录: $SourceDir"
Write-Host "输出目录: $OutputRoot"
Write-Host ""

# --- 逐个打包 ---
$SuccessCount = 0
$FailCount    = 0

foreach ($ThemeDir in $ThemeDirs) {
    $ConfigPath = Join-Path $ThemeDir.FullName "config.json"
    $ThemeNameDisplay = $ThemeDir.Name

    if (-not (Test-Path $ConfigPath)) {
        Write-Warning "跳过 $ThemeNameDisplay : 缺少 config.json"
        $FailCount++
        continue
    }

    # 从 config.json 读取 packageName
    try {
        $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
    } catch {
        Write-Warning "跳过 $ThemeNameDisplay : config.json 解析失败 - $_"
        $FailCount++
        continue
    }

    $PackageName = $Config.packageName
    if ([string]::IsNullOrWhiteSpace($PackageName)) {
        Write-Warning "跳过 $ThemeNameDisplay : config.json 中缺少 packageName"
        $FailCount++
        continue
    }

    $OutputFile = Join-Path $OutputRoot "${PackageName}.vst"
    Write-Host "[$ThemeNameDisplay] → $OutputFile" -ForegroundColor Yellow

    # 收集需要打包的文件（展平路径，不带父目录前缀）
    $FileQueue = @()
    foreach ($File in Get-ChildItem -Path $ThemeDir.FullName -Recurse -File) {
        if ($File.Extension.ToLower() -in $IncludeExtensions) {
            $RelativePath = $File.FullName.Substring($ThemeDir.FullName.Length + 1)
            $FileQueue += @{ Source = $File.FullName; Target = $RelativePath -replace '\\', '/' }
        }
    }

    # 打包为 .vst (ZIP)
    try {
        if (Test-Path $OutputFile) {
            Remove-Item $OutputFile -Force
        }

        $Zip = [System.IO.Compression.ZipFile]::Open(
            $OutputFile,
            [System.IO.Compression.ZipArchiveMode]::Create
        )
        foreach ($Entry in $FileQueue) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $Zip, $Entry.Source, $Entry.Target
            ) | Out-Null
        }
        $Zip.Dispose()

        # 验证打包完整性
        $ZipCheck = [System.IO.Compression.ZipFile]::OpenRead($OutputFile)
        $EntryCount = $ZipCheck.Entries.Count
        $ZipCheck.Dispose()

        $FileSize = [math]::Round((Get-Item $OutputFile).Length / 1KB, 1)
        if ($EntryCount -eq $FileQueue.Count) {
            Write-Host "  ✓ 完成 (${EntryCount} 个文件, ${FileSize} KB)" -ForegroundColor Green
            $SuccessCount++
        } else {
            Write-Warning "  ⚠ 文件数不匹配: 期望 $($FileQueue.Count), 实际 ${EntryCount} ($FileSize KB)"
            $SuccessCount++
        }
    } catch {
        Write-Error "  ✗ 打包失败: $_"
        $FailCount++
    }
}

# --- 汇总 ---
Write-Host ""
Write-Host "=== 完成 ===" -ForegroundColor Cyan
Write-Host "成功: $SuccessCount | 失败: $FailCount"
if ($FailCount -gt 0) { exit 1 }
