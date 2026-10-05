/**
 * El proyecto usa Leaflet sin `@types/leaflet`. Esta declaración mínima evita
 * el error "no hay archivo de declaración" en los mapas hechos con Leaflet
 * directo (components/mapa-ruta-clientes.tsx, mapa-ubicacion-cliente.tsx):
 * todo lo de Leaflet queda como `any`.
 */
declare module "leaflet"
