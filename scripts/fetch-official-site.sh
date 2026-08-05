#!/usr/bin/env bash
# 抓取桃園捷運官網各站時刻表頁面（備援資料源），存到 data/raw/official/
# 用法：bash scripts/fetch-official-site.sh
set -u
cd "$(dirname "$0")/.."
mkdir -p data/raw/official

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
BASE="https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide"
ok=0

fetch() { # $1=url $2=outfile
  code=$(curl -sS -L --compressed -A "$UA" --max-time 30 -w "%{http_code}" -o "$2" "$1" 2>/dev/null) || code=000
  size=$(wc -c < "$2" 2>/dev/null || echo 0)
  if [ "$code" = "200" ] && [ "$size" -gt 2000 ]; then
    echo "✓ $1 (${size}B)"; return 0
  fi
  echo "✗ $1 (HTTP $code, ${size}B)"; rm -f "$2"; return 1
}

fetch "$BASE/timetable.html" "data/raw/official/timetable-main.html" && ok=$((ok+1))

for id in A1 A2 A3 A4 A5 A6 A7 A8 A9 A10 A11 A12 A13 A14a A15 A16 A17 A18 A19 A20 A21 A22; do
  out="data/raw/official/timetable-$id.html"
  fetch "$BASE/timetable-$id" "$out" || fetch "$BASE/timetable-$id.html" "$out"
  [ -f "$out" ] && ok=$((ok+1))
  sleep 1
done

# 各站首末班/發車資訊頁（結構探索用）
fetch "$BASE/dep-A12" "data/raw/official/dep-A12.html" || fetch "$BASE/dep-A12.html" "data/raw/official/dep-A12.html" || true

echo "完成：$ok 頁"
[ "$ok" -gt 0 ] || exit 1
