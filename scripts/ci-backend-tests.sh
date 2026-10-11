#!/usr/bin/env bash
# Exactly the command the CI "Backend tests" step runs (serial, TAP, annotations).
set +e
: > tap.log
failed=0
for file in $(ls test/*.test.mjs); do
  node --test --test-reporter=tap "$file" >> tap.log 2>&1 || failed=1
done
if [ $failed -ne 0 ]; then
  names=$(grep -E "^not ok" tap.log | head -12 | tr '\n' '|' | tr -d '\r')
  echo "::error title=BACKEND TESTS FAILED::${names}"
  details=$(grep -E "^[[:space:]]+(error|location|code|expected|actual|operator):" tap.log | head -40 | tr '\n' '|' | tr -d '\r')
  echo "::error title=TAP ERROR DETAILS::$(printf '%.3500s' "$details")"
  echo "──── last 25 lines ────"
  tail -25 tap.log
else
  grep -E "^# (tests|pass|fail|skipped)" tap.log || true
fi
rm -f tap.log
exit $failed
