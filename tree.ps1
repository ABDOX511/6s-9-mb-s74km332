[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Show-ProjectTree {
    param(
        [string]$Path = $PSScriptRoot,
        [string[]]$NoRecurse = @("node_modules", ".wwebjs_auth", ".wwebjs_cache","clients","server",".git"),
        [string]$Prefix = "",
        [bool]$IsRoot = $true
    )

    if ($IsRoot) {
        $resolvedPath = Resolve-Path $Path
        $projectName = Split-Path $resolvedPath -Leaf
        Write-Output "Project Tree:`n$projectName"
    }

    $items = Get-ChildItem -LiteralPath $Path -Force | Sort-Object { -not $_.PSIsContainer }, Name
    $count = $items.Count
    $i = 0

    foreach ($item in $items) {
        $i++
        $isLastItem = $i -eq $count

        if ($isLastItem) {
            $connector = "└── "
        } else {
            $connector = "├── "
        }

        Write-Output ("$Prefix$connector" + $item.Name)

        if ($item.PSIsContainer) {
            if ($NoRecurse -contains $item.Name) {
                continue
            }
            if ($isLastItem) {
                $newPrefix = $Prefix + "    "
            } else {
                $newPrefix = $Prefix + "│   "
            }
            Show-ProjectTree -Path $item.FullName -NoRecurse $NoRecurse -Prefix $newPrefix -IsRoot:$false | Write-Output
        }
    }
}

# Print to console
Show-ProjectTree @PSBoundParameters

# Copy to clipboard
$tree = Show-ProjectTree @PSBoundParameters | Out-String
if ($tree) {
    $tree | Set-Clipboard
    Write-Host "`n(Tree output copied to clipboard!)"
} else {
    Write-Host "`n(No output to copy!)"
}
