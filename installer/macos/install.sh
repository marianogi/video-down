#!/bin/bash
# Instala video-down en macOS para el usuario actual (sin sudo).
#
#  1. Copia la extensión y el componente nativo a ~/Library/Application Support/video-down.
#  2. Descarga Deno y ffmpeg en versiones fijadas (Apple Silicon o Intel) y comprueba su SHA-256.
#  3. Descarga la última versión estable de yt-dlp y la comprueba contra su SHA2-256SUMS.
#  4. Escribe config.json, el lanzador video-down-host.sh y el manifiesto del componente nativo
#     para Chrome, Edge, Brave y Chromium.
#  5. Comprueba que todo responde y abre chrome://extensions y la carpeta de la extensión.
#
# Es idempotente: ejecutarlo otra vez actualiza yt-dlp y rehace la configuración.
# Uso: bash install.sh [--no-launch]

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${VIDEO_DOWN_HOME:-$HOME/Library/Application Support/video-down}"
NO_LAUNCH=0
[ "${1:-}" = "--no-launch" ] && NO_LAUNCH=1

bold() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$1" >&2; printf 'No se ha completado la instalación. Revisa la conexión a Internet y vuelve a ejecutar el instalador.\n' >&2; exit 1; }
trap 'fail "falló el paso anterior (línea $LINENO)"' ERR

[ "$(uname -s)" = "Darwin" ] || fail "este instalador es para macOS"

VERSIONS="$SOURCE_DIR/versions.json"
[ -f "$VERSIONS" ] || VERSIONS="$APP_DIR/versions.json"
[ -f "$VERSIONS" ] || fail "no se encuentra versions.json"

# Read a value from versions.json with the system's plutil (macOS 12+), falling back to JavaScript for Automation.
json() {
  local value
  if value=$(/usr/bin/plutil -extract "$1" raw -o - "$VERSIONS" 2>/dev/null); then
    printf '%s' "$value"
  else
    /usr/bin/osascript -l JavaScript -e 'function run(argv){var o=JSON.parse($.NSString.stringWithContentsOfFileEncodingError(argv[0],4,null).js);argv[1].split(".").forEach(function(k){o=o[k]});return o}' "$VERSIONS" "$1"
  fi
}

download() { # url dest
  printf '    %s\n' "$1"
  /usr/bin/curl --fail --location --silent --show-error --retry 3 --user-agent video-down-installer -o "$2" "$1"
}

check_sha256() { # file expected
  local actual
  actual=$(/usr/bin/shasum -a 256 "$1" | awk '{print $1}')
  if [ "$actual" != "$2" ]; then
    fail "la huella SHA-256 de $(basename "$1") no coincide (esperada $2, obtenida $actual). Descarga cancelada por seguridad."
  fi
  printf '    SHA-256 correcta\n'
}

case "$(uname -m)" in
  arm64) ARCH=macosArm64 ;;
  x86_64) ARCH=macosX64 ;;
  *) fail "arquitectura no soportada: $(uname -m)" ;;
esac

HOST_NAME=$(json hostName)
EXT_ID=$(json extensionId)
TMP=$(mktemp -d -t video-down)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

printf 'video-down: instalación en %s (%s)\n' "$APP_DIR" "$ARCH"

# ------------------------------------------------------------------ 1. ficheros
bold "Copiando la extensión y el componente nativo"
mkdir -p "$APP_DIR"/{bin,state,tmp,logs,cache}
if [ "$(cd "$SOURCE_DIR" && pwd -P)" != "$(cd "$APP_DIR" && pwd -P)" ]; then
  for item in extension native-host; do
    rm -rf "${APP_DIR:?}/$item"
    cp -R "$SOURCE_DIR/$item" "$APP_DIR/$item"
  done
  cp "$SOURCE_DIR/versions.json" "$APP_DIR/versions.json"
  for script in install.sh uninstall.sh; do
    [ -f "$SOURCE_DIR/$script" ] && cp "$SOURCE_DIR/$script" "$APP_DIR/$script"
  done
fi
printf '    hecho\n'
BIN="$APP_DIR/bin"
INSTALLED="$BIN/installed.txt"
touch "$INSTALLED"

# ------------------------------------------------------------------ 2. Deno
DENO_VERSION=$(json deno.version)
bold "Deno $DENO_VERSION"
if grep -qx "deno=$DENO_VERSION-$ARCH" "$INSTALLED" && [ -x "$BIN/deno" ]; then
  printf '    ya instalado\n'
else
  download "$(json "deno.$ARCH.url")" "$TMP/deno.zip"
  check_sha256 "$TMP/deno.zip" "$(json "deno.$ARCH.sha256")"
  /usr/bin/ditto -x -k "$TMP/deno.zip" "$TMP/deno"
  install -m 0755 "$TMP/deno/deno" "$BIN/deno"
  grep -v '^deno=' "$INSTALLED" > "$TMP/i" || true
  echo "deno=$DENO_VERSION-$ARCH" >> "$TMP/i" && mv "$TMP/i" "$INSTALLED"
fi

# ------------------------------------------------------------------ 3. ffmpeg
FFMPEG_VERSION=$(json ffmpeg.version)
bold "ffmpeg $FFMPEG_VERSION"
if grep -qx "ffmpeg=$FFMPEG_VERSION-$ARCH" "$INSTALLED" && [ -x "$BIN/ffmpeg" ] && [ -x "$BIN/ffprobe" ]; then
  printf '    ya instalado\n'
else
  for tool in ffmpeg ffprobe; do
    key="$ARCH"
    [ "$tool" = "ffprobe" ] && key="${ARCH}Probe"
    download "$(json "ffmpeg.$key.url")" "$TMP/$tool.zip"
    check_sha256 "$TMP/$tool.zip" "$(json "ffmpeg.$key.sha256")"
    /usr/bin/ditto -x -k "$TMP/$tool.zip" "$TMP/$tool"
    found=$(find "$TMP/$tool" -type f -name "$tool" | head -n 1)
    [ -n "$found" ] || fail "no se encontró $tool dentro del paquete"
    install -m 0755 "$found" "$BIN/$tool"
  done
  grep -v '^ffmpeg=' "$INSTALLED" > "$TMP/i" || true
  echo "ffmpeg=$FFMPEG_VERSION-$ARCH" >> "$TMP/i" && mv "$TMP/i" "$INSTALLED"
fi

# ------------------------------------------------------------------ 4. yt-dlp
bold "yt-dlp (última versión estable)"
TAG=$(/usr/bin/curl --fail --silent --location --user-agent video-down-installer \
  https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1 || true)
if [ -n "$TAG" ]; then
  BASE="https://github.com/yt-dlp/yt-dlp/releases/download/$TAG"
else
  printf '    no se pudo consultar la API de GitHub; se usa el enlace «latest»\n'
  BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"
fi
download "$BASE/SHA2-256SUMS" "$TMP/SHA2-256SUMS"
download "$BASE/yt-dlp_macos" "$TMP/yt-dlp"
EXPECTED=$(awk '$2 == "yt-dlp_macos" {print $1}' "$TMP/SHA2-256SUMS")
[ -n "$EXPECTED" ] || fail "SHA2-256SUMS no contiene yt-dlp_macos"
check_sha256 "$TMP/yt-dlp" "$EXPECTED"
install -m 0755 "$TMP/yt-dlp" "$BIN/yt-dlp"

# Files fetched with curl are not quarantined, but clear the flag in case they were copied from a download.
/usr/bin/xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true

# ------------------------------------------------------------------ 5. configuración
bold "Configuración"
DOWNLOADS="$HOME/Downloads"
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
printf '{\n  "downloadDir": "%s",\n  "version": "%s"\n}\n' "$(json_escape "$DOWNLOADS")" "$(json videodown)" > "$APP_DIR/config.json"
printf '    carpeta de descargas: %s\n' "$DOWNLOADS"

# Launcher: Deno with explicit permissions. It resolves its own folder, so it works from any path.
cat > "$APP_DIR/video-down-host.sh" <<'LAUNCHER'
#!/bin/sh
APP="$(cd "$(dirname "$0")" && pwd -P)"
export DENO_DIR="$APP/deno-cache"
export DENO_NO_UPDATE_CHECK=1
exec "$APP/bin/deno" run --quiet --no-prompt --no-config --no-lock --no-remote --no-npm \
  "--allow-read=$APP" \
  "--allow-write=$APP/state,$APP/tmp,$APP/logs" \
  "--allow-run=$APP/bin/yt-dlp" \
  "$APP/native-host/src/host.ts" "$@"
LAUNCHER
chmod 0755 "$APP_DIR/video-down-host.sh"

MANIFEST=$(printf '{\n  "name": "%s",\n  "description": "video-down native component (yt-dlp)",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": ["chrome-extension://%s/"]\n}\n' \
  "$HOST_NAME" "$(json_escape "$APP_DIR/video-down-host.sh")" "$EXT_ID")
printf '%s' "$MANIFEST" > "$APP_DIR/native-host-manifest.json"

# ------------------------------------------------------------------ 6. registro en los navegadores
bold "Registrando el componente nativo en el navegador"
for browser_dir in \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/Microsoft Edge" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" \
  "$HOME/Library/Application Support/Chromium"; do
  mkdir -p "$browser_dir/NativeMessagingHosts"
  printf '%s' "$MANIFEST" > "$browser_dir/NativeMessagingHosts/$HOST_NAME.json"
done
printf '    hecho\n'

# ------------------------------------------------------------------ 7. comprobación
bold "Comprobando el componente nativo"
if ! CHECK=$("$APP_DIR/video-down-host.sh" --self-check 2>&1); then
  printf '    %s\n' "$CHECK"
  fail "la comprobación del componente nativo ha fallado"
fi
printf '    %s\n' "$CHECK"

printf '\n\033[1;32mComponente nativo instalado.\033[0m\n\n'
printf 'Último paso, una sola vez (Chrome no permite que un programa lo haga por ti):\n'
printf '  1. En chrome://extensions activa «Modo de desarrollador» (arriba a la derecha).\n'
printf '  2. Pulsa «Cargar descomprimida» y elige esta carpeta:\n'
printf '       \033[1;33m%s\033[0m\n' "$APP_DIR/extension"
printf '     (en el selector, pulsa Cmd+Mayús+G y pega la ruta)\n'
printf '  3. Abre las opciones de video-down y pulsa «Comprobar de nuevo».\n'

if [ "$NO_LAUNCH" = "0" ]; then
  /usr/bin/open "$APP_DIR/extension" || true
  /usr/bin/open -a "Google Chrome" "chrome://extensions" 2>/dev/null || true
fi
