#!/usr/bin/env bash
# Install apt packages on a cell with dpkg-lock recovery.
#
# Why this exists: birth's step 3 used to do `apt-get update && apt-get
# install ...` inside one big sprite_exec heredoc. When the network hiccupped
# mid-install, /var/lib/dpkg/lock-frontend stayed held and mother had no
# prescribed recovery — she'd improvise polling loops and wait ~16 minutes.
# This helper handles the lock case once, deterministically.
#
# Usage: scripts/apt-install-on-cell.sh <cell-name> <pkg> [pkg...]
#
# Idempotent — packages already present become no-ops. Verifies each
# requested package resolves to a binary on PATH after install.
set -euo pipefail

NAME="${1:?usage: $0 <cell-name> <pkg> [pkg...]}"
shift
[ "$#" -gt 0 ] || { echo "no packages requested"; exit 1; }
PKGS="$*"

# pkg → expected binary name (most are 1:1; these aren't).
# Used for post-install verification.
# Use `bash -c`, not `bash -lc`. Login mode triggers ~/.bash_logout which
# runs `clear_console -q` and returns non-zero with no TTY, overriding our
# exit code and making every successful run look like a failure. Default
# PATH is fine here — all packages we install land in /usr/bin.
sprite exec -s "$NAME" -- bash -c "
set -euo pipefail
PKGS='$PKGS'

bin_for() {
  case \"\$1\" in
    ripgrep) echo rg ;;
    bat) echo batcat ;;
    *) echo \"\$1\" ;;
  esac
}

# Fast path: every requested package's binary is already on PATH.
all_present=1
for p in \$PKGS; do
  command -v \"\$(bin_for \"\$p\")\" >/dev/null 2>&1 || { all_present=0; break; }
done
if [ \"\$all_present\" = 1 ]; then
  echo \"all requested packages already installed: \$PKGS\"
  exit 0
fi

# Wait up to 30s for dpkg locks to free naturally.
# Sprite VMs don't have fuser/lsof — use flock to probe. If flock can't grab
# the lock non-blocking, something else holds it.
LOCKS='/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock'
probe_held() {
  for lk in \$LOCKS; do
    [ -e \"\$lk\" ] || continue
    if ! sudo flock -n -x \"\$lk\" -c true 2>/dev/null; then echo 1; return; fi
  done
  echo 0
}
waited=0
while [ \$waited -lt 30 ]; do
  [ \"\$(probe_held)\" = 0 ] && break
  sleep 2; waited=\$((waited+2))
done

# Force-unlock if still held.
held=\$(probe_held)
if [ \"\$held\" = 1 ]; then
  echo 'dpkg lock still held after 30s — force-unlocking'
  # Match by process name with -x (whole-string). pkill -f against
  # 'apt|dpkg' would match our own bash whose cmdline contains the script
  # body and kill ourselves with SIGKILL.
  for proc in apt-get apt dpkg; do
    sudo pkill -9 -x \"\$proc\" 2>/dev/null || true
  done
  sudo rm -f \$LOCKS
  sudo dpkg --configure -a || true
fi

run_apt() {
  sudo apt-get update -y && sudo apt-get install -y \$PKGS
}

if ! run_apt; then
  echo 'apt failed once; retrying after 5s'
  sleep 5
  run_apt || { echo 'apt failed twice — aborting (mother: surface this to Pete, do not loop)'; exit 2; }
fi

# Verify every requested package resolved to a binary on PATH.
missing=
for p in \$PKGS; do
  b=\"\$(bin_for \"\$p\")\"
  command -v \"\$b\" >/dev/null 2>&1 || missing=\"\$missing \$p(\$b)\"
done
if [ -n \"\$missing\" ]; then
  echo \"installed but missing on PATH:\$missing\"
  exit 3
fi

echo \"installed: \$PKGS\"
"
