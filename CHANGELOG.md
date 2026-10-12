# Registro de cambios

Cada versión publicada tiene un número propio y nunca cambia de contenido. Para publicar cualquier
cambio, primero se sube el número con `node installer/set-version.mjs <x.y.z>`; el generador de
paquetes se niega a empaquetar código distinto con un número ya publicado.

En `chrome://extensions`, las compilaciones que no son de publicación aparecen como
`<versión>-dev (<commit>)`.

## 0.1.5 (2026-10-12)

Correcciones generales del motor del navegador (todas heredadas de Media Bridge, encontradas
contrastando con el estándar HLS, RFC 8216):

- **AES-128 sin vector de inicialización** (muy común en CDN): el vector es el número de secuencia del
  segmento. Antes se guardaba el segmento aún cifrado y ffmpeg fallaba con «FS error».
- **AES-128 con vector explícito**: cada bloque de 32 bits se escribía con 2 cifras en vez de 8, y el
  vector salía mal si empezaba por ceros.
- **Rangos de bytes** (`EXT-X-BYTERANGE`, vídeo en un único fichero): antes se descargaba el fichero entero
  por cada segmento.
- La clave de cifrado se pide una vez por descarga, no una por segmento, y se valida (16 bytes).
- ffmpeg.wasm: se comprueba su código de salida y el error cuenta el motivo real.
- **Respaldo automático**: si una descarga HLS/DASH falla en el navegador y el componente nativo está
  instalado, la misma descarga continúa con yt-dlp y el ffmpeg nativo.
- El menú avisa si otras listas de la página (por ejemplo una *master* con más calidades) no se pudieron
  leer, con el motivo.
- **Descargas que se quedaban en 0 %**: si un fichero pequeño o el MP4 final terminaba antes de que la
  extensión empezara a escuchar el aviso de «terminado», la descarga esperaba para siempre (o hasta 5
  minutos). Ahora se escucha antes y se comprueba el estado real. El plazo de guardado pasa a 30 minutos
  para dar tiempo al diálogo «Guardar como».
- Menos registro en la consola de las páginas.
- Pruebas nuevas: los tres casos de HLS anteriores, el respaldo automático y una comparación automática
  de calidades con yt-dlp (coinciden en HLS y DASH).

## 0.1.4 (2026-10-12)

- La comprobación del componente nativo espera hasta 20 s (el primer arranque de Deno puede ser
  lento con el antivirus o en equipos cargados), comparte una sola comprobación entre peticiones
  simultáneas, y un «no instalado» solo se recuerda 5 s en lugar de un minuto. Antes, un arranque
  lento hacía que un vídeo grande se descargase en el navegador en vez de pasar a yt-dlp.
- Incluye todo lo de la 0.1.3.

## 0.1.3 (2026-10-12) — no publicada

Se instaló solo en el equipo de desarrollo; la verificación en Windows limpio encontró el fallo
corregido en la 0.1.4.

- Disciplina de versiones: un único número (en `extension/package.json`) para la extensión, el
  componente nativo y los instaladores. El componente nativo ya no dice «0.1.0» con otra versión
  instalada: lee su número del paquete instalado.
- Las compilaciones de prueba se ven en `chrome://extensions` como `<versión>-dev (<commit>)`.
- El popup y las opciones muestran la versión de la extensión y la del componente, y avisan si no
  coinciden.
- El generador de paquetes se niega a empaquetar cambios sin guardar o código distinto con un número
  ya publicado. Nuevo `installer/set-version.mjs` para subir el número en todos los sitios.

## 0.1.2 (2026-10-12)

- Corrige una carrera del content script: los avisos de listas que llegaban mientras arrancaba
  (service worker recién despertado) se perdían y el menú acababa en yt-dlp con «Unsupported URL».
- Las respuestas de error leídas a través del service worker ya no se toman por listas de vídeo.
- Una lista que falla se reintenta cuando el reproductor la vuelve a pedir, y se adopta la URL con
  el token más reciente.
- Diagnóstico en el menú cuando el vídeo se encuentra pero no se puede leer: rechazo HTTP, página o
  JSON en lugar de lista, formato propio cifrado (no se rompe) o error de conexión.
- Registros sin tokens y en nivel de depuración.

## 0.1.1 (2026-10-12)

- Detección universal para reproductores incrustados en otro sitio: los manifiestos se leen desde
  el marco del reproductor o con su `Origin`, `Referer` y cookies.
- Las cabeceras cubren todos los servidores de la lista (manifiesto, variantes, segmentos y claves)
  y respetan puertos no estándar.
- Listas HLS o DASH reconocidas también por su contenido.
- Errores del componente nativo legibles y sin URLs en crudo.

## 0.1.0 (2026-10-12)

- Primera versión: icono sobre cada vídeo con menú de resoluciones; descarga directa, HLS y DASH en
  el navegador con ffmpeg.wasm; YouTube y formatos propios con el componente nativo (yt-dlp); aviso
  de DRM sin descarga; instaladores para Windows (`.exe`) y macOS (`.zip`).
- Nota: antes de publicarse, varias compilaciones intermedias de prueba se instalaron también como
  0.1.0. Desde la 0.1.3 eso ya no es posible.
