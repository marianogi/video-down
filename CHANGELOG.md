# Registro de cambios

Cada versión publicada tiene un número propio y nunca cambia de contenido. Para publicar cualquier
cambio, primero se sube el número con `node installer/set-version.mjs <x.y.z>`; el generador de
paquetes se niega a empaquetar código distinto con un número ya publicado.

En `chrome://extensions`, las compilaciones que no son de publicación aparecen como
`<versión>-dev (<commit>)`.

## 0.2.16 (2026-10-17)

La 0.2.14 y la 0.2.15 no llegaron a publicarse: su verificación en macOS encontró el fallo que corrige el
último punto de la lista.

- **Al actualizar la extensión, las pestañas abiertas siguen funcionando sin recargarlas.** Chrome deja en
  cada pestaña abierta los scripts de la versión anterior, pero desconectados de la extensión. Su icono
  seguía ahí y su menú salía con las claves internas de los textos (`menuTitle`, `needNativeTitle`…) y un
  aviso falso de que hacía falta el componente nativo. Además, la consola mostraba
  `Extension context invalidated` en `content.js` cada vez que el reproductor leía una lista. Ahora:
  - Un script desconectado se retira solo: quita su icono, sus escuchas y sus temporizadores sin un error.
  - Al instalarse, actualizarse o recargarse, la extensión pone sus scripts en las pestañas ya abiertas, una
    vez por carga y al arrancar su service worker. Pregunta antes a cada marco si ya tiene un script en
    marcha y solo lo pone donde falta. Lo repite durante los primeros segundos, por si Chrome aún no ha
    desmontado los scripts viejos. Para ello pide el permiso `scripting`, que solo usa en ese momento.
  - La versión nueva recupera las listas que la página ya había pedido (en el registro de recursos de la
    página), así que el menú ofrece las mismas calidades que si se hubiera recargado.
  - Con pestañas abiertas en la 0.2.13 o anteriores, cuyos scripts no saben retirarse, el icono viejo
    queda oculto y los avisos de la página ya no les llegan.
  - El script que se retiraba quitaba su icono, pero un repintado pedido justo antes lo volvía a poner, y
    en una pestaña en segundo plano eso pasaba al volver a ella. Además, dejaba puesta su marca de «ya
    hay un script aquí». Ahora un repintado pendiente no hace nada tras la retirada, y la marca se quita
    para que la versión nueva pueda entrar.
- Pruebas: una nueva recarga la extensión con el botón de `chrome://extensions` con una página abierta,
  como tras ejecutar el instalador. Comprueba que queda un solo icono, que el menú ofrece las calidades y
  que no hay ningún error (47 de extremo a extremo más 5 opcionales, y 67 unitarias). La primera versión
  de esa prueba recargaba la extensión por el protocolo de depuración, y en macOS eso no arranca el
  service worker nuevo. Se ha comprobado también con el paquete real de la 0.2.13: su icono queda oculto
  y no hay errores.

## 0.2.13 (2026-10-17)

- **La consola de la página ya no se llena de errores en rojo de la extensión.** Para reconocer un
  vídeo, la extensión lee su lista de calidades, y lo hacía primero desde la propia página. Cada lectura
  rechazada salía en la consola de la página como un error en rojo atribuido a `content.js`. Se
  rechazaban, por ejemplo, la de un servidor que exige ser el reproductor (403) y la de la lista
  maestra que la extensión prueba junto a una calidad suelta (404 si no está), además de los bloqueos
  por CORS. Ahora todas las lecturas las hace el service worker, con el mismo `Origin` y `Referer` que
  la página, y sus fallos ya no aparecen en la consola de la página. Lo que se reconoce no cambia.
- Pruebas: una nueva comprueba que ninguna lectura de la extensión deja una línea roja en la consola
  de la página (46 de extremo a extremo más 5 opcionales, y 67 unitarias). Además, las pruebas esperan
  a que se abra la pestaña de bienvenida de la instalación y la cierran antes de empezar: en un Mac
  lento de GitHub se abría ya empezada la primera prueba, pasaba por delante y dejaba el vídeo en segundo plano.

## 0.2.12 (2026-10-17)

- **Cada calidad de un HLS con su propio audio.** Algunas listas maestras dan a cada calidad su propio
  grupo de audio. X, por ejemplo, da 32 kbps a la de 270p, 64 kbps a la de 360p y 128 kbps a las de
  720p en adelante. La extensión emparejaba todas con el primer audio de la lista, el peor, así que un
  vídeo de X en 720p salía con el sonido a 32 kbps. Ahora cada calidad usa el audio del grupo que
  indica su propia línea (`AUDIO=`), o el marcado por defecto dentro de ese grupo. Vale para las
  descargas, para la copia exacta de directos y para la elección automática del motor de descarga.
- Pruebas: unitaria con la lista maestra real de un vídeo público de X (67 en total).

## 0.2.11 (2026-10-16)

- **«Guardar como…» propone el nombre de la grabación, no un código.** El diálogo proponía un código
  como `2c21cb6f-….mp4`. Se reprodujo con la extensión «IDM Integration Module» (Internet Download
  Manager) cargada junto a video-down: esa extensión propone el nombre de cada descarga, y su propuesta
  pasaba por delante del nombre que video-down daba como parámetro. Para una grabación, ese nombre es el
  código del bloque de datos. Ahora el grabador propone su nombre en ese mismo paso, el que Chrome usa
  para decidir los nombres, solo para su propia descarga y mientras dura. Como gana la extensión
  instalada más recientemente, y video-down se recarga en cada actualización, su nombre es el que se
  usa. Comprobado con un Chromium de prueba y la extensión de IDM cargada: sin el cambio, el fichero se
  llama `2c21cb6f-….mp4`; con él, lleva el nombre de la grabación.
- **La pestaña de grabación, por fases.**
  - **Mientras graba:** solo **Detener** y **Descartar** (detener y borrar lo grabado). No muestra
    reproductor: el directo ya se ve en su pestaña. El diferido sigue disponible bajo demanda con
    **«Ver en diferido»**, que muestra aquí lo grabado sin parar la grabación, con «Ir al directo».
  - **Detenida:** el nombre propuesto (editable), **Guardar como…** y **Descartar**.
  - **Guardada:** la ruta del fichero, **Mostrar en la carpeta** y el reproductor para verla ahí mismo.
    Se puede guardar otra copia. Descartar borra la copia de video-down, no el fichero guardado.
  - Se recuerda dónde se guardó: al volver a abrir la pestaña desde el botón de la barra, sigue
    mostrando la ruta, «Mostrar en la carpeta» y el reproductor.
- Pruebas: las de grabación comprueban los botones de cada fase, que no hay reproductor mientras graba
  salvo «Ver en diferido» (probado con el directo HLS) y que lo hay al guardar.

## 0.2.10 (2026-10-16)

- **La copia exacta de un directo ya graba cuando el servidor redirige cada fragmento.** En la web de
  deportes del usuario la grabación se quedaba en 0 B y contaba los fragmentos como perdidos. Cada
  fragmento responde con una redirección (302) a otro servidor, y ese segundo servidor exige el
  `Referer` del reproductor. La extensión pone esas cabeceras solo para los servidores que aparecen en
  la lista, y Chrome no las conserva al seguir una redirección a otro servidor: el segundo respondía
  403. Ahora, si una petición con las cabeceras de la página se redirige a otro servidor y este la
  rechaza, ese servidor recibe las mismas cabeceras y se pide otra vez. Vale también para las descargas
  HLS del navegador: antes fallaban y, si estaba instalado, terminaba la descarga yt-dlp. Comprobado en
  el directo real: 36 s grabados en 30 s, sin fragmentos perdidos.
- **Dónde se graba y con qué nombre.** La pestaña de grabación dice dónde se graba: en el
  almacenamiento de video-down dentro de Chrome, en el disco, sin ir a ninguna carpeta hasta guardarla.
  Propone un nombre (título, calidad y hora de inicio) que se puede cambiar. «Guardar en Descargas» pasa
  a ser **«Guardar como…»** y siempre abre el diálogo de Chrome para elegir carpeta y nombre. Al
  terminar muestra la ruta completa del fichero y un botón **«Mostrar en la carpeta»**. Si se cancela el
  diálogo, la grabación sigue ahí.
- **Título de las grabaciones de reproductores incrustados.** Si el vídeo está en un iframe, la grabación
  toma el título de la pestaña (el nombre del partido, por ejemplo) y no el del reproductor («Live
  Stream»).
- Pruebas: de extremo a extremo, una descarga HLS y una copia de un directo cuyos fragmentos redirigen a
  otro servidor que exige el `Referer` (las dos fallan con la 0.2.9: la descarga solo salía por
  yt-dlp y la copia se quedaba sin nada), un directo incrustado en un iframe (la grabación lleva el título
  de la página), y el nombre propuesto, editable, con la ruta y «Mostrar en la carpeta» al guardar. La
  de YouTube real recarga una vez si YouTube no enseña el vídeo a la primera (aviso de cookies o
  anuncio), porque fallaba de vez en cuando por eso.

## 0.2.9 (2026-10-16)

- **Reproductores tapados por una capa transparente.** Muchas webs ponen una capa invisible encima del
  reproductor incrustado, para cazar el primer clic con un anuncio o para gestionar ellas los clics. El
  ratón no llegaba nunca al iframe del reproductor: el icono de video-down se veía, pero no se
  desplegaba ni se podía pulsar. Ahora el iframe le dice a la página dónde están su icono y su menú, y
  la página deja pasar el ratón por esa capa solo mientras está sobre ellos. Al apartarse y con el menú
  cerrado, la capa vuelve a ser de la página. Si el ratón sale del iframe de golpe, la página se lo
  dice al iframe para que el icono se pliegue.
- **Listas en directo disfrazadas.** Hay CDN de directos que sirven la lista sin extensión y como
  `text/html`. La extensión no miraba las respuestas `text/html` ni JSON, y no veía la lista. Ahora las
  mira también: si empiezan como una lista HLS o DASH se reconocen, y si no se dejan en el primer
  trozo, como cualquier otra respuesta. Con la lista reconocida, el directo ofrece también la copia
  exacta (sin recodificar), además de la captura del reproductor.
- Comprobado en la web de deportes del usuario: el icono se despliega en descargar y grabar, y el menú
  de grabar ofrece la copia exacta del directo y la captura.
- Pruebas: de extremo a extremo, un reproductor en un iframe tapado por una capa transparente (el icono
  se despliega, el menú se abre, la capa no recibe el clic y vuelve a ser de la página al irse) y un
  directo cuya lista se sirve como `text/html` sin extensión (botón de grabar y copia exacta). Las dos
  fallan con la 0.2.8.

## 0.2.8 (2026-10-15)

- **Más directos reconocidos, con su botón de grabar.** Desde que el botón de grabar solo sale en
  directos (0.2.2), algunos directos no lo mostraban:
  - **Listas que solo atienden al reproductor.** Al encontrar la master de una emisión, la extensión
    leía su primera calidad para saber si era un directo. Muchos servidores de directos solo responden a
    su reproductor, y si esa lectura fallaba (403) se daba por hecho que no lo era. Cuando después el
    reproductor leía la calidad y esta decía que sí, se descartaba por «pertenecer a una master ya
    conocida». Ahora lo que lee el reproductor manda: si una calidad de la master es un directo, la
    master pasa a serlo, y la lectura propia empieza por una calidad que el reproductor ya haya leído.
  - **Duración que crece.** Los reproductores basados en hls.js dan por defecto a un directo una
    duración finita que crece con cada recarga de la lista. Ahora cuenta como directo un vídeo cuya
    duración crece más de un segundo dos veces. La de un vídeo entero no cambia una vez conocida.
  - **Duración enorme.** Algunos reproductores dan al directo una duración gigantesca en lugar de
    infinita. Más de una semana cuenta como directo.
- Pruebas: de extremo a extremo, un directo cuya lista solo atiende al reproductor (la lectura de la
  extensión recibe 403) y un directo sin listas visibles cuya duración crece. Los dos fallan con la
  0.2.7 (sin botón de grabar). En YouTube real se comprueba también que un vídeo normal no muestra el
  botón de grabar.

## 0.2.7 (2026-10-15)

- **Los errores de las páginas ya no aparecen como errores de video-down.** Para ver las listas que lee
  el reproductor y los cambios de dirección, la extensión envuelve en la página `fetch`,
  `XMLHttpRequest`, `history.pushState` y `setMediaKeys`. Chrome atribuye un error sin atender al script
  que está en lo alto de la pila, y ese envoltorio estaba siempre ahí. Así, cuando fallaba una petición
  propia de la página que esta no atendía (una bloqueada por un bloqueador de anuncios, por ejemplo), o
  cuando la página llamaba mal a esas funciones, `chrome://extensions` lo listaba como error de
  video-down en `main-world.js` (por ejemplo, `TypeError: Failed to fetch`). Ahora:
  - `fetch`, `createMediaKeys` y `setMediaKeys` se llaman un instante después, solo a través de
    funciones nativas, así que ninguna función de la extensión queda en la pila;
  - `XMLHttpRequest` se vigila desde que se crea el objeto: la página llama ella misma a `open` y `send`;
  - los cambios de dirección se reciben con la API Navigation, sin envolver `pushState` ni
    `replaceState`.

  Los errores siguen saliendo en la consola, pero atribuidos a la página, que es de quien son. Lo que
  la página recibe no cambia.
- Si la página ya había leído la respuesta cuando la extensión iba a copiarla, la copia fallaba con un
  error sin atender. Ahora se descarta en silencio.
- **Textos de reserva en las páginas de la extensión.** En la CI de Windows, Chrome abrió una vez la página
  del grabador (en segundo plano) sin darle el catálogo de textos: `chrome.i18n` contestaba vacío a todo y
  se veía «recStateRecording» en lugar de «Recording». El grabador, las opciones y el menú de la barra
  llevan ahora una copia del catálogo en español e inglés y la usan cuando Chrome no contesta. Lo que se
  inyecta en las webs no la lleva y no crece.
- CI: en Windows no se subían las pruebas fallidas ni los registros porque el registro del componente
  nativo está en `C:` y el código en `D:`. Ahora los registros se copian dentro de los resultados antes de
  subirlos (también en macOS).
- Pruebas: de extremo a extremo, una página con una petición bloqueada como lo haría un bloqueador de
  anuncios, un segundo `send()`, un `pushState` a otro origen y un `setMediaKeys` erróneo, ninguno
  atendido. Ningún error debe aparecer atribuido a la extensión, y la página tiene que seguir leyendo sus
  respuestas, también con una subclase de `XMLHttpRequest`. Con la 0.2.6 falla (`TypeError: Failed to
  fetch` en `main-world.js`). Unitarias: 66, con los textos de reserva.

## 0.2.6 (2026-10-15)

- **El icono ya no se queda en una previsualización tras cerrar el menú sin descargar.** En la 0.2.5,
  el icono se quedaba quieto mientras el ratón estaba sobre él, pero se soltaba al plegarse. Al cerrar
  el menú con la × o con Escape, el foco vuelve al botón de descarga y el icono no se pliega, así que
  seguía retenido. Como YouTube usa un solo reproductor para todas sus previsualizaciones, el icono se
  quedaba en la miniatura donde se abrió el menú y las demás previsualizaciones aparecían sin icono.
  Ahora el icono solo se retiene mientras el ratón está sobre él o su menú está abierto.
- Pruebas: de extremo a extremo, un menú cerrado con la × sin descargar y el reproductor compartido
  pasando a otra miniatura: el icono va con él y solo hay uno. Falla con la 0.2.5.

## 0.2.5 (2026-10-15)

- **El icono ya no parpadea sobre las previsualizaciones de YouTube.** El icono de video-down no forma
  parte de la página, así que, al ponerle el ratón encima, YouTube entendía que el ratón había salido
  de la miniatura y retiraba la previsualización. El icono desaparecía con ella, el ratón volvía a
  quedar sobre la miniatura, YouTube la reproducía otra vez y el icono volvía a salir: así en bucle,
  y con el puntero desapareciendo también. Ahora, mientras el ratón está sobre el icono, el icono se
  queda donde estaba y con su vídeo, aunque la página retire el reproductor. Se suelta al apartar el
  ratón.
- **Las opciones de descarga se buscan al pasar el ratón por el icono.** Si el ratón se queda un
  cuarto de segundo sobre el icono, la extensión empieza a buscar en segundo plano las calidades y
  tamaños disponibles. Al hacer clic, el menú las tiene ya, o le falta menos para tenerlas. Solo se
  hace una consulta anticipada a yt-dlp a la vez, para que pasar el ratón por una cuadrícula de
  miniaturas no lance una por cada una.
- Pruebas: de extremo a extremo, una previsualización que la página retira en cuanto el ratón sale de
  su miniatura (el icono no se mueve ni desaparece durante un segundo y medio) y un fichero cuyo
  servidor tarda 3 s en dar su tamaño (se pregunta una sola vez, antes del clic, y el menú abre con
  él). Las dos fallan con la 0.2.4.

## 0.2.4 (2026-10-15)

- **Sin iconos duplicados ni descolocados al abrir un vídeo desde su previsualización.** YouTube no
  retira su reproductor de previsualizaciones al abrir el vídeo: lo deja debajo de la página nueva, y
  la extensión le seguía dibujando un icono en su antiguo sitio. Ahora un vídeo tapado por otra cosa de
  la página, o transparente, no tiene icono: se mira qué hay de verdad en pantalla en el centro y en
  dos esquinas del vídeo (los controles del propio reproductor cuentan como parte del vídeo).
- **Previsualizaciones que no están dentro de su enlace.** Además del enlace que envuelve al vídeo, se
  reconoce el enlace que ocupa su mismo recuadro, por encima o por debajo: la miniatura enlazada sobre
  la que se reproduce la previsualización, como hace YouTube en algunas páginas. Antes esas
  previsualizaciones se quedaban en «Esperando a que el vídeo empiece a cargar… dale al play».
- Si aun así en una página de YouTube que no es la de un vídeo no se sabe a qué vídeo lleva, el menú
  dice que se abra el vídeo y se use su icono, en lugar de pedir que se le dé al play.
- Pruebas: 65 unitarias; de extremo a extremo, un vídeo tapado, una web de una sola página que abre el
  vídeo encima de la previsualización y una previsualización colocada sobre su miniatura (las tres
  fallan con la 0.2.3).

## 0.2.3 (2026-10-15)

- **Caracteres especiales en lo que descarga yt-dlp.** En Windows, yt-dlp escribía su salida en la
  página de códigos de la consola y la ruta que devuelve llegaba estropeada («¡» se veía «�»). Ahora se
  lanza con `--encoding utf-8`. El fichero ya se guardaba con el nombre correcto; lo estropeado era la
  ruta que mostraba el menú.
- **yt-dlp guarda donde guardaría Chrome, y pregunta si se lo pides.** Antes iba a la carpeta fijada
  por el instalador sin preguntar nunca. Ahora una descarga mínima de marcador deja que Chrome decida la
  ruta (su carpeta de descargas, o su diálogo «Guardar como» si está activado en video-down o en Chrome);
  se borra al momento y yt-dlp escribe allí el vídeo, con ese nombre. Cancelar el diálogo cancela la
  descarga. El componente nativo valida la carpeta y el nombre.
- **El progreso, arriba del menú.** Con muchas opciones quedaba debajo y no se veía.
- **El menú se queda quieto y con su vídeo.** YouTube usa un único reproductor para todas sus
  previsualizaciones y lo mueve de miniatura en miniatura: el menú lo seguía y acababa en otro sitio.
  Ahora, al abrirse, fija su posición en la página y el vídeo al que se refiere, y no se cierra aunque
  la web retire el reproductor mientras carga.
- **Mensaje mientras carga:** «Analizando las opciones de descarga disponibles, espera por favor...».
- Pruebas: 64 unitarias, 17 del componente nativo y una de extremo a extremo con un reproductor de
  previsualización compartido que la página mueve y retira con el menú abierto.

## 0.2.2 (2026-10-14)

- **Un solo icono de «play»** en cada vídeo. Al pasar el ratón (o al pulsarlo, con el teclado o en
  pantallas táctiles) se desdobla en los botones de descarga y de grabación; Escape lo pliega. Plegado,
  sigue mostrando el anillo de progreso de una descarga y un punto rojo si se está grabando. El
  desdoble se decide por la posición del ratón, no por los avisos de entrada y salida de Chrome: con el
  ratón quieto sobre el icono, Chrome no siempre avisa al botón que aparece debajo, y el icono habría
  parpadeado (lo destapó la prueba en macOS limpio de GitHub).
- **Grabar, solo en directos.** El botón de grabación aparece solo en emisiones en directo: duración
  infinita (directos y flujos en tiempo real, como WebRTC) o lista HLS/DASH en directo. Lo demás se
  descarga entero.
- **Previsualizaciones.** Un vídeo dentro de un enlace a otra página (las miniaturas de YouTube que se
  reproducen al pasar el ratón, y las de cualquier web) es un avance de esa página: la descarga es del
  vídeo completo de la página a la que lleva, con yt-dlp, nunca del avance. Ahí no se ofrece grabar.
  Comprobado en YouTube: el avance es un `<video>` dentro de su enlace `/watch?v=…`.
- **Captura con el audio atascado.** MediaRecorder no escribe nada mientras alguna pista no entrega
  datos; si el audio de la página nunca arranca, la captura se reinicia a los 8 s con la imagen sola y
  la pestaña de grabación lo avisa.
- Pruebas: 63 unitarias; de extremo a extremo, el icono que se desdobla (ratón y teclado), una
  previsualización dentro de un enlace, un directo sin lista (MediaStream) y uno sin audio.

## 0.2.1 (2026-10-14)

- **Masters de Unified Streaming: salen todas las calidades.** Esas listas declaran la pista de audio
  sin dirección propia (`#EXT-X-MEDIA:TYPE=AUDIO` sin `URI`), algo que permite el estándar (RFC 8216):
  el audio va dentro de cada calidad. El analizador heredado de Media Bridge intentaba resolver esa
  dirección inexistente, fallaba al leer la master entera y solo quedaba la calidad que sonaba. Era la
  causa de que los cursos con el reproductor de Hotmart ofrecieran una sola calidad. Encontrado gracias
  al informe de diagnóstico que mandó el usuario.
- **El diagnóstico distingue «no se pudo descargar» de «se descargó pero no se entendió»**, con el
  error (sin direcciones). Antes, un fallo al interpretar una lista aparecía como fallo de red.
- Pruebas: una unitaria con una master así y una de extremo a extremo que reproduce el caso (falla con
  la 0.2.0).

## 0.2.0 (2026-10-14)

**Grabar en directo, con diferido.** Un segundo botón, con un punto rojo, en cada vídeo:

- **Copia exacta del directo** (HLS): guarda los segmentos originales a medida que aparecen, sin
  recodificar. Eliges la calidad y ves cuánto ocupa por hora. Segmentos por número de secuencia, inicio
  en el borde del directo, AES-128 descifrado, cortes marcados si un segmento se pierde, y cierre solo
  cuando la emisión termina. Cualquier otro cifrado es DRM y no se graba.
- **Captura del reproductor** (cualquier vídeo sin DRM): `captureStream()` + `MediaRecorder` en MP4
  fragmentado, con cuatro perfiles: máxima calidad (H.264 + AAC), equilibrado (VP9 + Opus), archivo
  pequeño (AV1 + Opus) y menos CPU (H.264 Baseline). Fotograma clave cada 2 s.
- **Pestaña de grabación** con reproductor en diferido (hls.js sirviendo lo grabado desde la base de
  datos del navegador, sin red): pausar, retroceder, «Ir al directo». Detener, guardar en Descargas
  (también a mitad) y descartar. Si se cierra la pestaña, la grabación sigue; el popup las lista.
- **El motor va en el service worker**, que no sufre el freno de temporizadores de las pestañas en
  segundo plano (una vez por minuto tras 5 minutos), y lo grabado va al disco trozo a trozo.
- **Guardado:** MP4 tal cual (captura o directo en fMP4), MPEG-TS pasado a MP4 sin recodificar hasta
  1 GB (`.ts` por encima), y audio y vídeo separados unidos hasta 1 GB (dos ficheros por encima).
- MediaRecorder escribe VP9 con nivel 0, que el propio reproductor de Chrome rechaza: se corrige en la
  cabecera de la grabación.
- Al arrancar Chrome se borran las reglas de cabeceras que hubiera dejado un trabajo cortado.
- Nueva dependencia: hls.js 1.7.3 (Apache-2.0, sin dependencias ni scripts de instalación).
- Pruebas: 57 unitarias; de extremo a extremo, un directo HLS simulado (copia, diferido, MP4) y la
  captura con los cuatro perfiles.

## 0.1.7 (2026-10-14)

Vídeos de webs que exigen sesión (Instagram, Facebook, Vimeo privado, plataformas de cursos…) y vídeos
vistos en un muro. Genérico: sin código para ninguna web concreta.

- **Tu sesión, solo cuando hace falta.** yt-dlp consulta primero sin sesión. Si responde que la necesita
  (inicio de sesión, cookies, 401/403, contenido privado o para miembros, edad, «no soy un robot»), la
  extensión repite con las cookies que Chrome enviaría a esa dirección y las vuelve a prestar para la
  descarga. yt-dlp ya no puede leerlas él mismo de Chrome en Windows (cifrado propio de Chrome desde la
  versión 127). En YouTube va desactivado por defecto porque puede penalizar la cuenta; hay un ajuste.
- **Componente nativo:** acepta cookies en `probe` y `download`, rechaza las de otra web y las que llevan
  caracteres de control, y las escribe en un fichero temporal de la carpeta del trabajo, legible solo por
  tu usuario, que se borra al terminar yt-dlp (y, si algo se interrumpe, a los 5 minutos). No se registran.
- **Muros:** si yt-dlp no reconoce la página (el inicio de Instagram, una línea de tiempo), se usa el
  enlace propio de la publicación que acompaña al vídeo: el que rodea su fecha (`<time>`) o el marcado
  como `rel="bookmark"`. Si junto al vídeo hay varios enlaces distintos, no se adivina.
- Nuevo permiso de la extensión: `cookies`. Chrome lo concede al recargar la extensión.
- Pruebas: 45 unitarias, 16 del componente nativo y una de extremo a extremo con un muro cuya publicación
  y cuyo vídeo solo se abren con sesión.

## 0.1.6 (2026-10-13)

Más calidades encontradas cuando la página solo deja ver una. Todo es genérico, sin código para
ninguna web concreta:

- **La copia del reproductor.** La extensión guarda el texto de cada lista HLS/DASH tal como lo
  recibió el reproductor de la página (solo si la página pidió de verdad esa dirección). Si la lista
  no se puede volver a leer (enlace de un solo uso o token que caduca en segundos), las calidades se
  sacan de esa copia. Antes el menú decía «no se ha podido leer» y solo ofrecía la calidad que se
  estaba reproduciendo.
- **Buscar la master junto a la variante.** Si la página solo pidió una calidad, se busca la lista
  *master* donde la ponen los empaquetadores habituales: Unified Streaming
  (`nombre-audio_eng=…-video_eng=….m3u8` → `nombre.m3u8`), Wowza, nginx-vod, sufijos tipo `_720p` y
  carpetas por calidad. Como mucho cuatro intentos, y solo se acepta una master que incluya la lista
  que se reproduce. Sus calidades heredan el token de la lista original.
- **Páginas que reescriben su propia dirección** (quitan el token, añaden el minuto…): ya no se
  borran las listas detectadas. Antes cualquier cambio de dirección vaciaba la lista y, si la master
  ya se había pedido, se perdía para siempre.
- **Webs de una sola página** (YouTube, cursos, plataformas): un vídeo nuevo se reconoce cuando el
  reproductor vuelve a cargar, y en ese momento se descartan las listas del anterior. La página
  avisa del cambio de dirección al instante, sin esperar al sondeo de cada segundo.
- **Listas pedidas por el service worker de la página**: ahora se reconocen. Antes se ignoraban porque
  no pertenecen a ninguna pestaña.
- La descarga HLS ya no falla si la master no se puede volver a leer: con la calidad elegida, va
  directa a ella.
- Si el menú está abierto y aparece una lista mejor (por ejemplo, la master de la única calidad que
  se mostraba), el menú se actualiza solo con sus calidades. Lo destapó la prueba en Windows limpio
  de GitHub, más lenta que el equipo de desarrollo.
- **Descargas directas rápidas que no decían «terminada».** Si Chrome avisaba de «completa» justo
  mientras la extensión comprobaba el estado (un fichero pequeño o local), un aviso de progreso
  tardío volvía a marcar la descarga como «descargando 100 %» después de terminada, y el menú se
  quedaba así. Ahora una descarga terminada no puede volver atrás, ni en el registro ni en el menú.
  Lo destapó la prueba en macOS limpio de GitHub, y una prueba unitaria nueva reproduce el orden
  exacto de los avisos. El menú guarda además los avisos de descargas que aún no conoce, por si el
  último llega antes que la respuesta con su identificador.
- **Informe de diagnóstico.** En el menú del vídeo (enlace «Informe de diagnóstico») y en el popup
  (botón «Diagnóstico»): qué listas pidió la página, desde qué marco, qué respondió el servidor y qué
  concluyó la extensión. Las direcciones van sin parámetros, sin tokens ni firmas. Se copia con un
  botón para enviarlo cuando un vídeo no sale como se esperaba.
- Pruebas nuevas: enlace de un solo uso con descarga, master encontrada junto a una variante con
  token, dirección reescrita, web de una sola página y service worker. Las cinco fallan con la 0.1.5.
  Unitarias: búsqueda de la master, copias del reproductor, informe y la carrera de las descargas
  directas (43 en total).

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
