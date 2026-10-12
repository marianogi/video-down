#!/bin/bash
# Doble clic en Finder para instalar video-down. Abre Terminal y ejecuta install.sh.
cd "$(dirname "$0")" || exit 1
/bin/bash ./install.sh
status=$?
echo
read -r -p "Pulsa Intro para cerrar esta ventana…" _
exit $status
