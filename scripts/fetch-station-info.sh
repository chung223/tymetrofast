#!/usr/bin/env bash
# 抓取桃園捷運官網各站「車站資訊」頁（中／英），存到 data/raw/station-info/{tw,en}/
# 頁面含設施（洗手間、無障礙電梯、置物櫃、YouBike…）與出口資訊表。
# 用法：bash scripts/fetch-station-info.sh
set -u
cd "$(dirname "$0")/.."

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
STATIONS="A1 A2 A3 A4 A5 A6 A7 A8 A9 A10 A11 A12 A13 A14a A15 A16 A17 A18 A19 A20 A21 A22"

total_ok=0
for lang in tw en; do
  out="data/raw/station-info/$lang"
  mkdir -p "$out"
  ok=0
  for id in $STATIONS; do
    url="https://www.tymetro.com.tw/tymetro-new/$lang/_pages/travel-guide/$id"
    f="$out/$id.html"
    code=$(curl -sS -L --compressed -A "$UA" --max-time 30 -w "%{http_code}" -o "$f" "$url" 2>/dev/null) || code=000
    size=$(wc -c < "$f" 2>/dev/null || echo 0)
    if [ "$code" = "200" ] && [ "$size" -gt 30000 ] && grep -q 'css_tr' "$f"; then
      echo "✓ $lang $id (${size}B)"
      ok=$((ok+1))
    else
      echo "✗ $lang $id (HTTP $code, ${size}B)"
      rm -f "$f"
    fi
    sleep 1
  done
  echo "$lang：$ok/22 站"
  total_ok=$((total_ok+ok))
done

echo "完成：共 $total_ok 頁"
[ "$total_ok" -ge 40 ] || exit 1
