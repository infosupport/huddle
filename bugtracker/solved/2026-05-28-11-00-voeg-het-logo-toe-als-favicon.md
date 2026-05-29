# Voeg het logo toe als favicon

**URL**: http://localhost:3000/#/dashboard
**Datum**: 28-5-2026, 11:00:58

## Opgelost — 28-5

`src/index.html` heeft nu `<link rel="icon">` voor `assets/logo-light.png` (light scheme) en `assets/logo-dark.png` (dark scheme). De assets stonden al in `src/assets/` en zijn al door `angular.json` (`assets` glob `**/*`) in de build opgenomen, dus geen extra config nodig.
