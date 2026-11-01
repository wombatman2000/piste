# Piste

Planificateur de parcours moto tout-terrain. Calcule l'itinéraire avec BRouter et un profil TT dédié (`moto-tt.brf`), puis l'envoie à OsmAnd en GPX.

## Mise en ligne (GitHub Pages)

1. Crée un dépôt public `piste` sur GitHub.
2. Dépose tous les fichiers de ce dossier à la racine du dépôt.
3. Settings → Pages → Source : branche `main`, dossier `/ (root)`.
4. Ouvre `https://<compte>.github.io/piste/` dans Safari, puis Partager → Sur l'écran d'accueil.

## Fichiers

- `index.html` : l'appli
- `core.js` : calculs (revêtement, dénivelé, GPX, carburant)
- `moto-tt.brf` : profil de routage BRouter, envoyé au serveur public brouter.de à chaque réglage
- `sw.js`, `manifest.webmanifest`, icônes : installation sur l'écran d'accueil

## Services utilisés

- BRouter (brouter.de) pour le calcul
- Overpass (OpenStreetMap) pour le calque des chemins et les stations
- Fonds IGN Géoplateforme, OpenTopoMap, OpenStreetMap, Esri
