#!/usr/bin/env bash
# 抓取桃園捷運官網各站時刻表頁面，平日與假日各一份，存到 data/raw/official/{weekday,holiday}/
# 官網以 cookie 記住查詢日期（station-timetable-date.php），故每個日別用獨立 cookie session。
# 用法：bash scripts/fetch-official-site.sh
set -u
cd "$(dirname "$0")/.."

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
BASE="https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide"
STATIONS="A1 A2 A3 A4 A5 A6 A7 A8 A9 A10 A11 A12 A13 A14a A15 A16 A17 A18 A19 A20 A21 A22"

# 台灣時區的下一個平日與下一個週六
export TZ=Asia/Taipei
if [ "$(date +%u)" -le 5 ]; then WEEKDAY_DATE=$(date +%F); else WEEKDAY_DATE=$(date -d "next monday" +%F); fi
HOLIDAY_DATE=$(date -d "next saturday" +%F)

fetch() { # $1=cookiejar $2=url $3=outfile
  code=$(curl -sS -L --compressed -A "$UA" -b "$1" -c "$1" --max-time 30 -w "%{http_code}" -o "$3" "$2" 2>/dev/null) || code=000
  size=$(wc -c < "$3" 2>/dev/null || echo 0)
  if [ "$code" = "200" ] && [ "$size" -gt 50000 ] && grep -q 'class="time-table"' "$3"; then
    echo "✓ $2 (${size}B)"; return 0
  fi
  echo "✗ $2 (HTTP $code, ${size}B)"; rm -f "$3"; return 1
}

total_ok=0
for kind in weekday holiday; do
  if [ "$kind" = "weekday" ]; then qdate="$WEEKDAY_DATE"; else qdate="$HOLIDAY_DATE"; fi
  out="data/raw/official/$kind"
  mkdir -p "$out"
  jar=$(mktemp)
  echo "── $kind（$qdate）──"
  # 先建立 session，再設定查詢日期 cookie
  curl -sS -L --compressed -A "$UA" -c "$jar" --max-time 30 -o /dev/null "$BASE/timetable.html" || true
  curl -sS -A "$UA" -b "$jar" -c "$jar" --max-time 30 -o /dev/null -X POST -d "date=$qdate" "$BASE/station-timetable-date.php" || true
  ok=0
  for id in $STATIONS; do
    f="$out/timetable-$id.html"
    fetch "$jar" "$BASE/timetable-$id" "$f" || fetch "$jar" "$BASE/timetable-$id.html" "$f"
    [ -f "$f" ] && ok=$((ok+1))
    sleep 1
  done
  rm -f "$jar"
  echo "$kind：$ok/22 站"
  total_ok=$((total_ok+ok))
done

mkdir -p data/raw/official
cat > data/raw/official/meta.json <<EOF
{ "fetchedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "weekdayDate": "$WEEKDAY_DATE", "holidayDate": "$HOLIDAY_DATE" }
EOF

echo "完成：共 $total_ok 頁"
[ "$total_ok" -ge 40 ] || exit 1
