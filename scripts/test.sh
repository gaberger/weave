#!/usr/bin/env bash
# weave test runner — robust to a broken or unwritable $TMPDIR so the suite runs anywhere.
#
# Both tsx's loader cache and the tests themselves (which mkdtemp via os.tmpdir())
# need a writable temp directory. os.tmpdir() honors $TMPDIR, so an inherited
# $TMPDIR that points at a non-existent/unmounted path (e.g. an external volume)
# fails every test with EACCES/ENOENT. If the inherited $TMPDIR isn't a writable
# directory, fall back to a repo-local one.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${TMPDIR:-}" ] || [ ! -d "${TMPDIR}" ] || [ ! -w "${TMPDIR}" ]; then
  TMPDIR="$PWD/.tmp"
  mkdir -p "$TMPDIR"
  export TMPDIR
fi

exec node --import tsx --test $(find src skills -name '*.test.ts')
