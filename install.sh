#!/usr/bin/env bash
#
# Install the Artemis terminal UI.
#
#   curl -fsSL https://raw.githubusercontent.com/seth-torrence/artemis/main/install.sh | bash
#
# Downloads the self-contained build for this machine from the latest GitHub
# release, puts it under ~/.local/share/artemis-tui, fetches a Node runtime if
# the machine has none new enough, and writes `artemis-tui` — and `artemis`,
# unless something else already answers to that name — into ~/.local/bin.
# Nothing is written anywhere else, and removing those two directories is the
# whole uninstall. Running it again — or `artemis-tui --update`, which does
# exactly that — moves to the latest release.
#
# The terminal UI reads the accounts the Artemis desktop app signed in, so it
# expects the desktop app to be installed on the same machine, or
# ARTEMIS_DATA_DIR to point at an installation's data directory.
#
# Knobs, all optional:
#   ARTEMIS_TUI_VERSION   a release version to install instead of the latest
#   ARTEMIS_TUI_HOME      where the build and runtime go
#   ARTEMIS_TUI_BIN       where the launchers go
#   ARTEMIS_TUI_TARBALL   a local tarball to install instead of downloading

set -euo pipefail

REPO="seth-torrence/artemis"
TUI_HOME="${ARTEMIS_TUI_HOME:-$HOME/.local/share/artemis-tui}"
BIN_DIR="${ARTEMIS_TUI_BIN:-$HOME/.local/bin}"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=12

say() { printf '%s\n' "$*" >&2; }
fail() { say "artemis-tui install: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required and was not found on PATH."; }

need curl
need tar
need mktemp

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "$(uname -s) is not supported by this installer. On Windows, run the terminal UI from a source checkout." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "$(uname -m) is not an architecture a release is built for." ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ---------------------------------------------------------------------------
# The build
# ---------------------------------------------------------------------------

version="${ARTEMIS_TUI_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || fail "could not find the latest release of $REPO."
fi

if [ -n "${ARTEMIS_TUI_TARBALL:-}" ]; then
  tarball="$ARTEMIS_TUI_TARBALL"
  [ -f "$tarball" ] || fail "$tarball does not exist."
else
  asset="artemis-tui-$version-$os-$arch.tar.gz"
  url="https://github.com/$REPO/releases/download/v$version/$asset"
  say "Downloading Artemis terminal UI $version for $os-$arch…"
  tarball="$tmp/$asset"
  curl -fsSL -o "$tarball" "$url" || fail "no build at $url — that release may not ship one for $os-$arch."
fi

dest="$TUI_HOME/versions/$version"
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$tarball" -C "$dest" --strip-components=1
[ -f "$dest/dist/main.js" ] || fail "the archive did not contain the terminal UI."

# ---------------------------------------------------------------------------
# A Node runtime: the machine's own when it is new enough, otherwise one of our
# own under TUI_HOME, so installing never touches the system's Node.
# ---------------------------------------------------------------------------

node_bin=""
if [ -z "${ARTEMIS_TUI_FORCE_NODE_DOWNLOAD:-}" ] && command -v node >/dev/null 2>&1; then
  have="$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)"
  IFS=. read -r major minor _ <<<"$have"
  if [ "${major:-0}" -gt "$NODE_MIN_MAJOR" ] || { [ "${major:-0}" -eq "$NODE_MIN_MAJOR" ] && [ "${minor:-0}" -ge "$NODE_MIN_MINOR" ]; }; then
    node_bin="$(command -v node)"
  fi
fi

if [ -z "$node_bin" ]; then
  say "Fetching a Node $NODE_MIN_MAJOR runtime…"
  sums="$(curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MIN_MAJOR.x/SHASUMS256.txt")"
  line="$(printf '%s\n' "$sums" | grep -E " node-v$NODE_MIN_MAJOR\.[0-9]+\.[0-9]+-$os-$arch\.tar\.gz$" | head -n 1)"
  [ -n "$line" ] || fail "nodejs.org lists no Node $NODE_MIN_MAJOR build for $os-$arch."
  expected="${line%% *}"
  file="${line##* }"
  curl -fsSL -o "$tmp/node.tar.gz" "https://nodejs.org/dist/latest-v$NODE_MIN_MAJOR.x/$file"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/node.tar.gz" | cut -d' ' -f1)"
  else
    actual="$(shasum -a 256 "$tmp/node.tar.gz" | cut -d' ' -f1)"
  fi
  [ "$actual" = "$expected" ] || fail "the Node download did not match its published checksum."
  rm -rf "$TUI_HOME/node"
  mkdir -p "$TUI_HOME/node"
  tar -xzf "$tmp/node.tar.gz" -C "$TUI_HOME/node" --strip-components=1
  node_bin="$TUI_HOME/node/bin/node"
fi

# ---------------------------------------------------------------------------
# The launchers
# ---------------------------------------------------------------------------

ln -sfn "$dest" "$TUI_HOME/current"
mkdir -p "$BIN_DIR"

# ARTEMIS_TUI_INSTALL tells the program it is an installed copy and where:
# `artemis-tui --update` runs the installer that shipped inside the build.
write_launcher() {
  cat >"$1" <<LAUNCHER
#!/bin/sh
ARTEMIS_TUI_INSTALL="$TUI_HOME"
export ARTEMIS_TUI_INSTALL
exec "$node_bin" "$TUI_HOME/current/dist/main.js" "\$@"
LAUNCHER
  chmod +x "$1"
}

write_launcher "$BIN_DIR/artemis-tui"
existing="$(command -v artemis 2>/dev/null || true)"
if [ -z "$existing" ] || [ "$existing" = "$BIN_DIR/artemis" ]; then
  write_launcher "$BIN_DIR/artemis"
  names="artemis-tui and artemis"
else
  # On Linux the desktop app's own launcher is /usr/bin/artemis. It keeps the name.
  names="artemis-tui (the name artemis belongs to $existing)"
fi

"$BIN_DIR/artemis-tui" --version >/dev/null 2>&1 || fail "the installed command did not start."

say ""
say "Installed Artemis terminal UI $version as $names."
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add $BIN_DIR to your PATH, e.g.:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say "Run it in a project directory:  artemis-tui"
say "To remove it:  rm -rf \"$TUI_HOME\" \"$BIN_DIR/artemis-tui\" \"$BIN_DIR/artemis\""
