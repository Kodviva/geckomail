#!/bin/sh
# Uygulama simgesi ve açılış ekranı build/icon_1024.png'den üretilir (ImageMagick). iOS simgesi köşesiz ve opak olmalı, Capacitor
# şablonundaki yer tutucular mağazaya gidemez. Kullanım: mobile/ dizininde sh scripts/gen-icons.sh
set -eu
SRC=../build/icon_1024.png
BG='#12170F'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
magick "$SRC" -background "$BG" -flatten -alpha off "$TMP/full.png"
magick "$TMP/full.png" -define png:exclude-chunk=date,time ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
for f in ios/App/App/Assets.xcassets/Splash.imageset/*.png android/app/src/main/res/drawable*/splash.png; do
  size=$(magick identify -format '%wx%h' "$f")
  w=${size%x*}; h=${size#*x}
  side=$(( (w < h ? w : h) / 4 ))
  magick -size "$size" xc:white \( "$SRC" -resize "${side}x${side}" \) -gravity center -composite -alpha off -define png:exclude-chunk=date,time "$f"
done
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d=${pair%:*}; s=${pair#*:}
  res=android/app/src/main/res/mipmap-$d
  magick "$TMP/full.png" -resize "${s}x${s}" -define png:exclude-chunk=date,time "$res/ic_launcher.png"
  magick "$TMP/full.png" -resize "${s}x${s}" \( -size "${s}x${s}" xc:black -fill white -draw "circle $((s/2)),$((s/2)) $((s/2)),0" \) -alpha off -compose CopyOpacity -composite -define png:exclude-chunk=date,time "$res/ic_launcher_round.png"
  fg=$((s * 9 / 4))  # 108dp tuval
  inner=$((s * 3 / 2))  # 72dp: uyarlamalı simgenin güvenli alanı
  magick -size "${fg}x${fg}" "xc:$BG" \( "$TMP/full.png" -resize "${inner}x${inner}" \) -gravity center -composite -define png:exclude-chunk=date,time "$res/ic_launcher_foreground.png"
done
sed -i '' "s/#FFFFFF/$BG/" android/app/src/main/res/values/ic_launcher_background.xml
