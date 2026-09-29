// Service Worker — Feelpay: Web Push + caché para trabajar sin señal

// Nombre versionado: al cambiarlo se descarta el caché viejo en `activate`.
const CACHE = "feelpay-app-v2";

// Tomar control inmediatamente al instalarse o actualizarse.
// Sin esto, cuando sw.js cambia el SW viejo sigue activo hasta que
// el usuario cierre todas las pestañas — el nuevo queda en "waiting"
// y el browser NO lo despierta para push en segundo plano.
// AL INSTALARSE YA SE GUARDA LA APP. Antes no se guardaba nada hasta la
// SEGUNDA carga con señal: en la primera, el HTML y los scripts bajaban antes
// de que el SW tomara control. Ahora se guarda el documento al instalar, y la
// página le manda la lista de lo que ya bajó (mensaje "precache", ver
// components/sw-register.tsx) para que quede todo desde la primera visita.
const BASICOS = ["/", "/manifest.json", "/opad-logo.png"];

async function guardarSiOk(cache, url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res && res.ok) await cache.put(url, res.clone());
  } catch {
    /* sin señal: se guardará la próxima vez */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(BASICOS.map((u) => guardarSiOk(cache, u)));
      await self.skipWaiting();
    })()
  );
});

// La página avisa qué archivos de la app ya descargó: se guardan los que falten.
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.tipo !== "precache" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const raw of data.urls) {
        try {
          const url = new URL(raw, self.location.origin);
          if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) continue;
          const clave = url.pathname === "/" ? "/" : url.href;
          if (await cache.match(clave)) continue;
          await guardarSiOk(cache, clave);
        } catch {
          /* url inválida: se ignora */
        }
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Borrar cachés de versiones anteriores.
      const nombres = await caches.keys();
      await Promise.all(nombres.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await clients.claim();
    })()
  );
});

// ---------------------------------------------------------------------------
// Caché de la app para que abra sin señal.
//
// SOLO se cachea la app en sí (documentos y assets estáticos). Los datos NUNCA
// pasan por aquí: las lecturas de Supabase van por IndexedDB
// (`lib/offline-cache.ts`) y las escrituras por la cola
// (`lib/offline-queue.ts`), que sí saben distinguir datos de hoy y reintentar.
// Cachear respuestas de la API acá mostraría saldos viejos sin control.
// ---------------------------------------------------------------------------

function esNavegacion(request) {
  return request.mode === "navigate";
}

function esAssetEstatico(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/_next/static/") ||
      url.pathname === "/manifest.json" ||
      /\.(?:js|css|woff2?|png|jpg|jpeg|svg|ico)$/.test(url.pathname))
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Nunca interceptar llamadas a datos (Supabase, APIs propias).
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Navegación: intentar red y caer al documento cacheado si no hay señal.
  //
  // CON SEÑAL DÉBIL NO SE ESPERA PARA SIEMPRE. En la calle lo común no es "sin
  // red" sino una red que no responde: el navegador se quedaba colgado
  // esperando y la app no abría. Si en 6 segundos no contesta, se sirve lo
  // guardado. Y solo se guarda una respuesta BUENA: antes se guardaba también
  // una página de error y quedaba como la app "sin señal".
  if (esNavegacion(request)) {
    event.respondWith(
      (async () => {
        try {
          const red = await Promise.race([
            fetch(request),
            new Promise((_, rechazar) => setTimeout(() => rechazar(new Error("lento")), 6000)),
          ]);
          if (red && red.ok) {
            const cache = await caches.open(CACHE);
            cache.put("/", red.clone());
          }
          return red;
        } catch {
          const cache = await caches.open(CACHE);
          const guardado = (await cache.match("/")) || (await cache.match(request));
          if (guardado) return guardado;
          return new Response(
            "<h1>Sin conexión</h1><p>Abre la app con señal al menos una vez.</p>",
            { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 503 }
          );
        }
      })()
    );
    return;
  }

  // Assets estáticos: servir del caché y refrescar en segundo plano.
  if (esAssetEstatico(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const guardado = await cache.match(request);
        const red = fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        return guardado || (await red) || Response.error();
      })()
    );
  }
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Nuevo reporte", body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Nuevo reporte", {
      body: data.body ?? "",
      icon: "/opad-logo.png",
      badge: "/opad-logo.png",
      tag: data.tag ?? "reporte",
      renotify: true,
      data: { url: data.url ?? "/" },
      vibrate: [200, 100, 200],
      requireInteraction: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin) && "focus" in client) {
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});

// Cuando el browser rota el endpoint push (renovación automática),
// notificar al servidor para que actualice la DB sin perder user_id/rol.
self.addEventListener("pushsubscriptionchange", (event) => {
  const newSub = event.newSubscription;
  const oldEndpoint = event.oldSubscription?.endpoint;

  if (!newSub || !oldEndpoint) return;

  const p256dhBuffer = newSub.getKey("p256dh");
  const authBuffer = newSub.getKey("auth");
  if (!p256dhBuffer || !authBuffer) return;

  const toBase64 = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)));

  event.waitUntil(
    fetch(self.location.origin + "/api/push/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        oldEndpoint,
        subscription: {
          endpoint: newSub.endpoint,
          keys: {
            p256dh: toBase64(p256dhBuffer),
            auth: toBase64(authBuffer),
          },
        },
      }),
    }).catch((err) => {
      console.error("[v0 sw] pushsubscriptionchange refresh error:", err);
    })
  );
});
