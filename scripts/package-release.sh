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
export NPM_CONFIG_CACHE="${temporary}/npm-cache"

archive="$(cd "${root}" && npm pack --silent --pack-destination "${temporary}")"
install -d "${temporary}/normalized"
tar --extract --gzip --file "${temporary}/${archive}" --directory "${temporary}/normalized"
install -m 0644 "${root}/SECURITY.md" "${temporary}/normalized/package/SECURITY.md"
node "${root}/scripts/vendor-runtime-dependencies.mjs" \
  --destination "${temporary}/normalized/package"

install -d "$(dirname "${target}")"
tar --sort=name --format=ustar --mtime=@0 --owner=0 --group=0 \
  --numeric-owner --mode=u=rwX,go=rX \
  --directory "${temporary}/normalized" --create --file - package \
  | gzip -n -9 > "${target}"
node "${root}/scripts/check-release-artifact.mjs" "${target}"
