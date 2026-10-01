#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-${root}/screenrig-cli.tgz}"
case "${target}" in
  /*) ;;
  *) target="${PWD}/${target}" ;;
esac

temporary="$(mktemp -d "${TMPDIR:-/tmp}/screenrig-cli-release.XXXXXX")"
trap 'rm -rf -- "${temporary}"' EXIT

# One minified dist/bin.js with every runtime dependency inside it, built from
# `npm run build` output. Renderer platform binaries are fetched on first render.
install -d "${temporary}/normalized/package"
node "${root}/scripts/bundle-release.mjs" \
  --destination "${temporary}/normalized/package"
install -m 0644 "${root}/LICENSE" "${root}/README.md" "${root}/SECURITY.md" \
  "${temporary}/normalized/package/"
version="${SCREENRIG_VERSION:-}"
if [ -z "${version}" ]; then
  version="$(node "${root}/scripts/calver.mjs" print --git "${root}")"
fi
node "${root}/scripts/calver.mjs" stamp --root "${temporary}/normalized/package" --version "${version}"
node "${root}/scripts/normalize-release-tree.mjs" \
  "${temporary}/normalized/package"

mkdir -p -- "$(dirname "${target}")"
if tar --version 2>/dev/null | grep -q "GNU tar"; then
  (
    cd "${temporary}/normalized"
    find package -print0 | LC_ALL=C sort -z | tar \
      --create --null --no-recursion --files-from - --file - \
      --format=ustar --mtime=@0 --owner=0 --group=0 --numeric-owner
  ) | gzip -n -9 > "${target}"
else
  (
    cd "${temporary}/normalized"
    find package -print0 | LC_ALL=C sort -z | tar \
      --create --null --no-recursion --files-from - --file - \
      --format=ustar --uid 0 --gid 0 --uname root --gname root --numeric-owner
  ) | gzip -n -9 > "${target}"
fi
node "${root}/scripts/check-release-artifact.mjs" "${target}"
