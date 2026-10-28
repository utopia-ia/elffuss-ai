#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Deploy one elffuss-ai site to its docroot, /var/www/<host>/site/. Called by
# deploy/deploy-<site>.sh; it refuses a dirty tree.
#
#   ELFFUSS_HOST=user@server ELFFUSS_KEY=<ssh key> deploy/deploy-<site>.sh [--channel pro|pre] [--ignore-window] [--dry-run]
#
# Order. Nothing outside v/, vendor/ and the site's own pages is ever touched,
# and nothing is synced with --delete, so /beta/ (PRE) and /blog/ survive a PRO deploy.
#   1. the server and the key come from the environment, never from the repo;
#   2. weekdays from 08:00 to 15:59 are refused unless --ignore-window
#      (ELFFUSS_HOLIDAY=1 says today is a holiday, which counts as a weekend);
#   3. fetch the pinned runtimes if vendor/ lacks them (vendor.mjs --ensure),
#      build from git archive HEAD, run the unit tests and the publication sweep
#      over the build, with their output on screen;
#   4. upload v/<build>/ (new), vendor/ (only adds), then the pages under
#      temporary names, each moved into place with mv -f (atomic);
#   5. prune: keep the three newest v/<build>/ and the vendor/ versions they use;
#   6. check by curl that what is served has the sha256 of the build.
set -euo pipefail

SITE="${1:?site name}"; shift
CHANNEL=pro; IGNORE_WINDOW=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="${2:?}"; shift 2 ;;
    --ignore-window) IGNORE_WINDOW=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$CHANNEL" in pro|pre) ;; *) echo "channel must be pro or pre" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# 1. Where to.
HOST=${ELFFUSS_HOST:?set ELFFUSS_HOST (user@server) before deploying}
KEY=${ELFFUSS_KEY:?set ELFFUSS_KEY (path to the ssh key) before deploying}
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
RSYNC=(rsync -a --checksum -e "ssh -i $KEY -o BatchMode=yes")

# 2. When.
DOW=$(date +%u); HOUR=$((10#$(date +%H)))
if [ "$IGNORE_WINDOW" != 1 ] && [ "${ELFFUSS_HOLIDAY:-0}" != 1 ] && [ "$DOW" -le 5 ] && [ "$HOUR" -ge 8 ] && [ "$HOUR" -lt 16 ]; then
  echo "✗ on weekdays from 08:00 to 15:59 nothing goes out (--ignore-window, or ELFFUSS_HOLIDAY=1 on a holiday)" >&2
  exit 1
fi

# 3. What: the commit, built, tested and swept.
if [ -n "$(/usr/bin/git status --porcelain)" ]; then echo "✗ the working tree is not clean" >&2; exit 1; fi
BUILD=$(/usr/bin/git rev-parse --short=12 HEAD)
SITE_HOST=$(node --input-type=module -e "import { site } from './deploy/sites.mjs'; console.log(site(process.argv[1]).host)" "$SITE")
DEST="/var/www/$SITE_HOST/site"
OUT="$ROOT/dist"
# The runtimes are not in git: vendor/ must match vendor/manifest.json byte for
# byte, and a clone without them fetches them here (by exact version, every sha256 checked).
node scripts/vendor.mjs --ensure
node scripts/build.mjs "$SITE" --channel "$CHANNEL" --out "$OUT"
node --test "tests/unit/*.test.mjs"
# the whole dist/: the sweep keys vendored files by <site>/vendor/…, so a single site's
# folder would flag every vendored file as a finding.
node scripts/sweep.mjs --release --git --dist "$OUT"
LOCAL="$OUT/$SITE"
PAGES_DIR=.; [ "$CHANNEL" = pre ] && PAGES_DIR=beta
PAGES=$(cd "$LOCAL" && find "$PAGES_DIR" \( -name '*.html' -o -name 'robots.txt' \) -not -path '*/v/*' -not -path '*/vendor/*' -not -name '._*' | sed 's|^\./||' | sort)

if [ "$DRY" = 1 ]; then
  echo "dry run: $SITE ($BUILD, $CHANNEL) would go to $HOST:$DEST"
  for p in $PAGES; do echo "  page: $p"; done
  exit 0
fi

# 4. Upload: the build's files, the runtimes, then the pages, swapped in atomically.
"${SSH[@]}" "mkdir -p '$DEST/v' '$DEST/vendor'"
"${RSYNC[@]}" "$LOCAL/v/$BUILD/" "$HOST:$DEST/v/$BUILD/"
# a site with no runtime (tools) builds no vendor/
if [ -d "$LOCAL/vendor" ]; then "${RSYNC[@]}" "$LOCAL/vendor/" "$HOST:$DEST/vendor/"; fi
TMP=".new-$BUILD"
for p in $PAGES; do
  "${SSH[@]}" "mkdir -p '$DEST/$(dirname "$p")'"
  "${RSYNC[@]}" "$LOCAL/$p" "$HOST:$DEST/$p$TMP"
done
for p in $PAGES; do "${SSH[@]}" "mv -f '$DEST/$p$TMP' '$DEST/$p'"; done

# 5. Prune: the three newest builds (always the one just uploaded) and the runtimes they use.
"${SSH[@]}" bash -s -- "$DEST" "$BUILD" <<'REMOTE'
set -euo pipefail
DEST="$1"; BUILD="$2"
cd "$DEST/v"
KEEP=$( { echo "$BUILD"; ls -1t; } | awk 'NF && !seen[$0]++' | head -3)
for d in *; do
  if ! printf '%s\n' "$KEEP" | grep -qxF -- "$d"; then echo "prune v/$d"; rm -rf -- "$d"; fi
done
USED=$(cat ./*/config.js | { grep -o '"/vendor/[^"]*' || true; } | sed -E 's|^"/vendor/((@[^/]+/)?[^/]+)/.*|\1|' | sort -u)
cd "$DEST/vendor"
for d in */ @*/*/; do
  d=${d%/}
  [ -d "$d" ] || continue
  case "$d" in @*/*) ;; @*) continue ;; esac
  if ! printf '%s\n' "$USED" | grep -qxF -- "$d"; then echo "prune vendor/$d"; rm -rf -- "$d"; fi
done
REMOTE

# 6. Check what is served (runtimes over 1 MB are left out: they are pinned by path and hash).
BASE="https://$SITE_HOST"
FAIL=0
while IFS= read -r f; do
  want=$(shasum -a 256 "$LOCAL/$f" | cut -d' ' -f1)
  got=$(curl -fsS "$BASE/$f" | shasum -a 256 | cut -d' ' -f1) || got=missing
  [ "$want" = "$got" ] || { echo "✗ $f is not what was built"; FAIL=1; }
done < <(cd "$LOCAL" && find . -type f -not -name '._*' \( -not -path './vendor/*' -o -size -1024k \) | sed 's|^\./||' | sort)
[ "$FAIL" = 0 ] || { echo "✗ $SITE ($BUILD): what is served is not the build" >&2; exit 1; }
echo "✓ $SITE ($BUILD, $CHANNEL) → $BASE/$( [ "$CHANNEL" = pre ] && echo beta/ )"
