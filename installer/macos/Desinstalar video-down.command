#!/bin/bash
# Doble clic en Finder para desinstalar video-down.
cd "$(dirname "$0")" || exit 1
/bin/bash ./uninstall.sh
echo
read -r -p "Pulsa Intro para cerrar esta ventana…" _
