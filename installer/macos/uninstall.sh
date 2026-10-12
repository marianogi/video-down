#!/bin/bash
# Desinstala video-down del usuario actual en macOS: quita el registro del componente nativo
# y borra su carpeta. La extensión hay que quitarla a mano en chrome://extensions.
# Las descargas ya hechas no se tocan. Uso: bash uninstall.sh [--keep-files]

set -u
APP_DIR="${VIDEO_DOWN_HOME:-$HOME/Library/Application Support/video-down}"
HOST_NAME="dev.marianogutierrez.videodown"

for browser_dir in \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/Microsoft Edge" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" \
  "$HOME/Library/Application Support/Chromium"; do
  rm -f "$browser_dir/NativeMessagingHosts/$HOST_NAME.json"
done
echo "Registro del componente nativo eliminado."

if [ "${1:-}" != "--keep-files" ] && [ -d "$APP_DIR" ]; then
  # Never delete anything that does not look like our own folder.
  if [ "$(basename "$APP_DIR")" != "video-down" ] || [ ! -d "$APP_DIR/native-host" ]; then
    echo "No se borra $APP_DIR porque no parece la carpeta de video-down."
    exit 1
  fi
  rm -rf "$APP_DIR"
  echo "Carpeta $APP_DIR eliminada."
fi
echo "Quita también la extensión en chrome://extensions."
