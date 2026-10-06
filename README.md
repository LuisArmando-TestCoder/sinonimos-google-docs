# Sinónimos — WordReference

Extensión de Chrome que muestra **sinónimos y definiciones en español** de una palabra, en un menú justo debajo del cursor:

- **En Google Docs**: mientras escribes (o seleccionas) una palabra.
- **En cualquier otra web**: cuando seleccionas una palabra con doble clic o arrastrando el ratón.

Seleccionas `persona` y aparece:

> **persona**
>
> **DEFINICIÓN**
> *f. Individuo de la especie humana...*
>
> **SINÓNIMOS**
> ser · individuo · sujeto · semejante · hombre · mujer...

En Google Docs, haz clic en un sinónimo para reemplazar la palabra. En las demás webs el menú solo muestra la definición y los sinónimos (solo lectura).

## Características

- Sinónimos y definiciones del diccionario Espasa-Calpe vía WordReference.
- En Google Docs, menú posicionado debajo del cursor siguiendo el caret real, con reemplazo con un clic o `Enter`.
- En cualquier web, al seleccionar una sola palabra (doble clic o arrastrar) aparece el menú debajo de la selección, tras una pausa de 300 ms.
- Guarda de "palabra única": si la selección, una vez recortados los espacios, contiene espacios dentro, se ignora (es más de una palabra).
- Funciona con acentos, pegado desde el portapapeles y palabras cortadas por error (un espacio y `Backspace` la recupera).
- Sin dependencias externas, sin telemetría, sin cuentas.

## Instalación (desarrollo)

1. Abre `chrome://extensions` en Chrome.
2. Activa **Modo de desarrollador** (arriba a la derecha).
3. Haz clic en **Cargar descomprimida**.
4. Selecciona la carpeta `sinonimos-docs`.

Tras cargar o recargar la extensión, recarga la pestaña del documento de Google Docs (las extensiones no se inyectan en pestañas ya abiertas).

## Uso

### En Google Docs

1. Abre un documento de Google Docs.
2. Escribe en español y pausa un instante (300 ms).
3. Aparece el menú debajo del cursor con la definición y los sinónimos.
4. Haz clic en un sinónimo para reemplazar la palabra, o sigue escribiendo.

### En cualquier otra web

1. Selecciona una palabra (doble clic, o arrastra el ratón sobre ella).
2. Espera un instante (300 ms) y aparece el menú debajo de la selección con la definición y los sinónimos.
3. Si seleccionas más de una palabra (hay espacios), el menú no aparece.

### Atajos

| Tecla | Acción |
| --- | --- |
| `Enter` | Reemplaza con el primer sinónimo |
| `Escape` | Cierra el menú |
| Clic fuera | Cierra el menú |

## Cómo funciona

**Google Docs** dibuja el documento en un canvas y captura la escritura en un iframe oculto (`docs-texteventtarget-iframe`), así que el texto no se puede leer del DOM normal. En ese caso la extensión:

1. **Rastrea la palabra** desde los eventos de teclado dentro del iframe de edición (incluye acentos, pegado y recuperación de palabra tras un espacio).
2. **Lee la posición del caret** desde la selección del iframe y la traduce a coordenadas de viewport.
3. **Consulta WordReference** desde el service worker (evita CORS):
   - `https://www.wordreference.com/sinonimos/<palabra>`
   - `https://www.wordreference.com/definicion/<palabra>`
4. **Muestra el menú** debajo del cursor y reemplaza la palabra al hacer clic.

**En cualquier otra web**, la extensión escucha `selectionchange` y `mouseup`; tras una pausa de 300 ms, si la selección (recortada) es una sola palabra (sin espacios internos), la consulta en WordReference y muestra el menú debajo de la selección. Si es más de una palabra, simplemente la ignora.

### Archivos

| Archivo | Rol |
| --- | --- |
| `manifest.json` | Manifiesto MV3, permisos e iconos |
| `background.js` | Service worker: fetch y parseo de WordReference |
| `content.js` | Script de contenido de Google Docs: rastreo de teclas, caret, popup y reemplazo |
| `content-generic.js` | Script de contenido genérico: selección de una palabra en cualquier web, popup de solo lectura |
| `styles.css` | Estilos del popup |
| `scripts/generate-icons.js` | Genera los iconos PNG sin dependencias |
| `icons/` | Iconos 16/48/128 generados |

## Desarrollo

```bash
# Generar (o regenerar) los iconos
node scripts/generate-icons.js

# Validar sintaxis de los scripts
node --check background.js
node --check content.js
```

## Publicación en Chrome Web Store

1. Comprime el contenido de `sinonimos-docs/` en un `.zip` (los archivos en la raíz del zip, no la carpeta).
2. Entra a [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
3. Crea un ítem nuevo y sube el zip.
4. Completa la ficha (ver `docs/store-listing.md` para textos listos).
5. Declara el permiso de host `https://www.wordreference.com/*` y el motivo de uso.

## Privacidad

La extensión no recopila datos. Lee la palabra que escribes solo para consultar WordReference y no la almacena ni la envía a ningún otro sitio. Ver `PRIVACY.md`.

## Licencia

MIT. Ver `LICENSE`.

## Repositorio

<https://github.com/LuisArmando-TestCoder/sinonimos-google-docs># sinonimos-google-docs
