# resources/media/make-ad.ps1 — Instagram (Reels/Stories) ad for LiBER.
#
#   powershell -ExecutionPolicy Bypass -File resources\media\make-ad.ps1
#   -> artifacts\media\liber-instagram-ad.mp4   (1080x1920, 30 fps, H.264 + AAC)
#
# Everything is generated from ffmpeg's own sources: no assets, no stock footage,
# no fonts beyond Windows'. Motion is procedural, so the file is reproducible and
# the script is the source of truth for the design.
param(
  [string]$Out = "artifacts\media\liber-instagram-ad.mp4",
  [string]$Ffmpeg = "ffmpeg"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null

$bold = 'C\:/Windows/Fonts/segoeuib.ttf'
$semi = 'C\:/Windows/Fonts/seguisb.ttf'
$mono = 'C\:/Windows/Fonts/consola.ttf'

# Brand
$gold = '0xE5B25C'
$cyan = '0x39C5F0'
$red  = '0xF0616D'
$green= '0x2FD07A'
$white= 'white'

function Fade($start, $dur = 0.35) {
  # alpha rises over $dur seconds starting at $start
  "alpha='if(lt(t,$start),0,min(1,(t-$start)/$dur))'"
}

# Each entry: text, font, size, y, colour, in, out
$lines = @(
  @{ t = 'your code';            f = $bold; s = 86;  y = 780; c = "$white@0.95"; a = 1.6;  b = 4.2 },
  @{ t = 'just failed';          f = $bold; s = 86;  y = 880; c = "$white@0.95"; a = 2.2;  b = 4.2 },
  @{ t = 'again.';               f = $bold; s = 150; y = 720; c = $red;          a = 4.2;  b = 7.0 },
  @{ t = 'LiBER reads the failure.'; f = $semi; s = 58; y = 800; c = "$white@0.92"; a = 7.2; b = 9.6 },
  @{ t = 'fixes it.';            f = $bold; s = 104; y = 790; c = $white;        a = 9.6;  b = 11.6 },
  @{ t = 'proves it.';           f = $bold; s = 104; y = 790; c = $cyan;         a = 11.6; b = 14.0 },
  @{ t = 'no claim without a receipt'; f = $semi; s = 50; y = 1500; c = "$white@0.85"; a = 14.4; b = 18.4 }
)

$draw = @()
foreach ($l in $lines) {
  $t = $l.t -replace ':', '\:'
  $draw += "drawtext=fontfile='$($l.f)':text='$t':fontsize=$($l.s):fontcolor=$($l.c):x=(w-text_w)/2:y=$($l.y):enable='between(t,$($l.a),$($l.b))':" + (Fade $l.a)
}

# Terminal card: a rounded panel with three lines that appear one after another.
$draw += "drawbox=x=90:y=560:w=900:h=360:color=0x101216@0.88:t=fill:enable='between(t,7.2,14.0)'"
$draw += "drawbox=x=90:y=560:w=900:h=2:color=$cyan@0.5:t=fill:enable='between(t,7.2,14.0)'"
$draw += "drawtext=fontfile='$mono':text='\$ liber fix':fontsize=40:fontcolor=$cyan:x=130:y=610:enable='between(t,7.4,14.0)':" + (Fade 7.4)
$draw += "drawtext=fontfile='$mono':text='[E1] terminal OK (exit 0)':fontsize=34:fontcolor=$white@0.9:x=130:y=690:enable='between(t,8.6,14.0)':" + (Fade 8.6)
$draw += "drawtext=fontfile='$mono':text='[E2] file patched':fontsize=34:fontcolor=$white@0.9:x=130:y=750:enable='between(t,9.4,14.0)':" + (Fade 9.4)
$draw += "drawtext=fontfile='$mono':text='GROUNDING PASS - 12 receipts':fontsize=34:fontcolor=$green:x=130:y=820:enable='between(t,10.6,14.0)':" + (Fade 10.6)

# Wordmark and CTA
$draw += "drawtext=fontfile='$bold':text='L i B E R':fontsize=190:fontcolor=$white:x=(w-text_w)/2:y=700:enable='between(t,14.4,18.6)':" + (Fade 14.4)
$draw += "drawtext=fontfile='$bold':text='<':fontsize=150:fontcolor=$gold:x=150:y=736:enable='between(t,14.4,18.6)':" + (Fade 14.4)
$draw += "drawtext=fontfile='$bold':text='>':fontsize=150:fontcolor=$gold:x=800:y=736:enable='between(t,14.4,18.6)':" + (Fade 14.4)

$draw += "drawtext=fontfile='$bold':text='npm i -g @arthovlabs/liber':fontsize=46:fontcolor=$cyan:x=(w-text_w)/2:y=1120:enable='between(t,18.4,20)':" + (Fade 18.4)
$draw += "drawtext=fontfile='$semi':text='autonomous engineering agent':fontsize=44:fontcolor=$white@0.8:x=(w-text_w)/2:y=1200:enable='between(t,0.4,4.2)+between(t,18.4,20)':" + (Fade 0.4)

$chain = ($draw -join ',')

$filter = @"
[0:v]scale=1080:1920,
zoompan=z='min(zoom+0.0006,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=30,
drawgrid=w=90:h=90:t=1:color=white@0.03,
vignette=PI/5,
$chain,
fade=t=in:st=0:d=0.6,fade=t=out:st=19.2:d=0.8,
format=yuv420p[v];
[1:a]volume=0.16,tremolo=f=0.25:d=0.6,afade=t=in:st=0:d=1.2,afade=t=out:st=18.6:d=1.4[a]
"@

$args = @(
  '-hide_banner', '-y',
  '-f', 'lavfi', '-i', "gradients=s=1080x1920:c0=0x0B1B3A:c1=0x070A10:c2=0x121A2E:n=3:speed=0.02:d=20:r=30",
  '-f', 'lavfi', '-i', "sine=frequency=55:duration=20:sample_rate=48000",
  '-f', 'lavfi', '-i', "sine=frequency=110:duration=20:sample_rate=48000",
  '-filter_complex', $filter,
  '-map', '[v]', '-map', '[a]',
  '-t', '20',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart',
  $Out
)

Write-Host "rendering $Out …"
& $Ffmpeg @args 2>&1 | Select-Object -Last 4
if ($LASTEXITCODE -ne 0) { Write-Host "ffmpeg failed ($LASTEXITCODE)" -ForegroundColor Red; exit 1 }
Write-Host "done: $Out"
