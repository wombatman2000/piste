/* Piste — fonctions de calcul (sans dépendance au navigateur) */
(function (root) {
  'use strict';

  var R = 6371008.8;
  function rad(d) { return d * Math.PI / 180; }

  // Distance en mètres entre deux points [lat, lng]
  function haversine(a, b) {
    var dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // Distances cumulées (m) le long d'une liste de points [lat, lng, ele?]
  function cumulative(coords) {
    var out = [0];
    for (var i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(coords[i - 1], coords[i]));
    return out;
  }

  function parseTags(str) {
    var tags = {};
    (str || '').split(/\s+/).forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) tags[kv.slice(0, i)] = kv.slice(i + 1);
    });
    return tags;
  }

  // Même logique que le profil BRouter : revetu, facile, terre, difficile
  var CLASSES = ['revetu', 'facile', 'terre', 'difficile'];
  function surfaceClass(tags) {
    var tt = tags.tracktype, s = tags.surface || '';
    var hard = /^(very_bad|horrible|very_horrible|off_road_wheels|impassable)$/.test(tags.smoothness || '') ||
      /^(yes|recommended)$/.test(tags['4wd_only'] || '');
    var c;
    if (tt === 'grade1') c = 'facile';
    else if (tt === 'grade2') c = 'facile';
    else if (tt === 'grade3') c = 'terre';
    else if (tt === 'grade4' || tt === 'grade5') c = 'difficile';
    else if (/^(gravel|fine_gravel|compacted|pebblestone)$/.test(s)) c = 'facile';
    else if (/^(unpaved|ground|dirt|earth|clay|soil)$/.test(s)) c = 'terre';
    else if (/^(grass|mud|sand|rock|rocks|stone)$/.test(s)) c = 'difficile';
    else if (s) c = 'revetu';
    else if (tags.highway === 'track') c = 'terre';
    else c = 'revetu';
    if (hard && c !== 'revetu') c = 'difficile';
    return c;
  }

  // Réponse GeoJSON de BRouter -> parcours exploitable
  function parseBrouter(json) {
    var f = json && json.features && json.features[0];
    if (!f) throw new Error('Réponse du calculateur vide');
    var coords = f.geometry.coordinates.map(function (c) {
      return [c[1], c[0], c.length > 2 ? c[2] : null];
    });
    var props = f.properties || {};
    var msgs = props.messages || [];
    var head = msgs[0] || [];
    var iDist = head.indexOf('Distance'), iTags = head.indexOf('WayTags');
    var segs = []; // {to: distance cumulée de fin, cls, tags}
    var acc = 0;
    for (var i = 1; i < msgs.length; i++) {
      var d = parseFloat(msgs[i][iDist]) || 0;
      acc += d;
      var tags = parseTags(msgs[i][iTags]);
      segs.push({ to: acc, cls: surfaceClass(tags), tags: tags });
    }
    var total = parseFloat(props['track-length']) || acc;
    return finish(coords, segs, total, parseFloat(props['filtered ascend']));
  }

  // Parcours importé (GPX) sans information de revêtement
  function fromCoords(coords) {
    var cum = cumulative(coords);
    return finish(coords, [], cum[cum.length - 1] || 0, NaN);
  }

  function finish(coords, segs, total, ascend) {
    var cum = cumulative(coords);
    var geomLen = cum[cum.length - 1] || 1;
    var scale = total > 0 ? geomLen / total : 1; // aligne les distances BRouter sur la géométrie
    var mix = { revetu: 0, facile: 0, terre: 0, difficile: 0, inconnu: 0 };
    var prev = 0;
    segs.forEach(function (s) { mix[s.cls] += (s.to - prev); prev = s.to; });
    if (!segs.length) mix.inconnu = total;

    // Découpe de la géométrie en tronçons colorés
    var pieces = [];
    if (segs.length) {
      var k = 0, cur = { cls: segs[0].cls, pts: [coords[0]] };
      for (var i = 1; i < coords.length; i++) {
        var at = (cum[i - 1] + cum[i]) / 2 / scale;
        while (k < segs.length - 1 && at > segs[k].to) k++;
        if (segs[k].cls !== cur.cls) {
          pieces.push(cur);
          cur = { cls: segs[k].cls, pts: [coords[i - 1]] };
        }
        cur.pts.push(coords[i]);
      }
      pieces.push(cur);
    } else {
      pieces.push({ cls: 'inconnu', pts: coords });
    }

    if (isNaN(ascend)) ascend = computeAscend(coords);
    return { coords: coords, cum: cum, length: geomLen, mix: mix, pieces: pieces, ascend: ascend };
  }

  // Dénivelé positif avec seuil de 5 m pour lisser le bruit
  function computeAscend(coords) {
    var up = 0, ref = null;
    coords.forEach(function (c) {
      if (c[2] == null || isNaN(c[2])) return;
      if (ref === null) { ref = c[2]; return; }
      if (c[2] > ref + 5) { up += c[2] - ref; ref = c[2]; }
      else if (c[2] < ref - 5) ref = c[2];
    });
    return up;
  }

  function unpavedShare(mix) {
    var t = mix.revetu + mix.facile + mix.terre + mix.difficile;
    return t > 0 ? (mix.facile + mix.terre + mix.difficile) / t : null;
  }

  // Durée estimée (h) selon vitesses moyennes route / chemin
  function estimateHours(r, vRoute, vTT) {
    var m = r.mix;
    var known = m.revetu + m.facile + m.terre + m.difficile;
    if (!known) return r.length / 1000 / ((vRoute + vTT) / 2);
    var k = r.length / known;
    return (m.revetu * k / 1000) / vRoute +
      ((m.facile * k / 1000) / (vTT * 1.2)) +
      ((m.terre * k / 1000) / vTT) +
      ((m.difficile * k / 1000) / (vTT * 0.6));
  }

  // Simplifie une ligne à n points max (échantillonnage régulier)
  function sample(coords, n) {
    if (coords.length <= n) return coords.slice();
    var out = [], step = (coords.length - 1) / (n - 1);
    for (var i = 0; i < n; i++) out.push(coords[Math.round(i * step)]);
    return out;
  }

  // Position (m depuis le départ) du point du parcours le plus proche
  function locateOnRoute(r, p) {
    var best = Infinity, at = 0;
    for (var i = 0; i < r.coords.length; i++) {
      var d = haversine(r.coords[i], p);
      if (d < best) { best = d; at = r.cum[i]; }
    }
    return { at: at, off: best };
  }

  // Écarts entre pleins : départ -> stations -> arrivée
  function fuelGaps(length, stationsAt, startFull) {
    var pts = stationsAt.slice().sort(function (a, b) { return a - b; });
    var marks = [startFull === false ? null : 0].concat(pts).concat([length]).filter(function (x) { return x !== null; });
    var gaps = [];
    for (var i = 1; i < marks.length; i++) gaps.push({ from: marks[i - 1], to: marks[i], len: marks[i] - marks[i - 1] });
    var max = gaps.reduce(function (m, g) { return Math.max(m, g.len); }, 0);
    return { gaps: gaps, max: max };
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // GPX 1.1 lisible par OsmAnd (trace + points d'intérêt)
  function buildGpx(name, coords, wpts) {
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Piste" xmlns="http://www.topografix.com/GPX/1/1" xmlns:osmand="https://osmand.net">',
      '<metadata><name>' + esc(name) + '</name></metadata>'];
    (wpts || []).forEach(function (w) {
      out.push('<wpt lat="' + w.lat.toFixed(6) + '" lon="' + w.lng.toFixed(6) + '"><name>' + esc(w.name) + '</name>' +
        (w.desc ? '<desc>' + esc(w.desc) + '</desc>' : '') +
        (w.icon ? '<extensions><osmand:icon>' + esc(w.icon) + '</osmand:icon></extensions>' : '') + '</wpt>');
    });
    out.push('<trk><name>' + esc(name) + '</name>');
    out.push('<extensions><osmand:color>#D9822B</osmand:color><osmand:width>bold</osmand:width></extensions>');
    out.push('<trkseg>');
    coords.forEach(function (c) {
      out.push('<trkpt lat="' + c[0].toFixed(6) + '" lon="' + c[1].toFixed(6) + '">' +
        (c[2] != null && !isNaN(c[2]) ? '<ele>' + Number(c[2]).toFixed(1) + '</ele>' : '') + '</trkpt>');
    });
    out.push('</trkseg></trk></gpx>');
    return out.join('\n');
  }

  // Lecture GPX (traces, routes ou points) sans DOMParser
  function parseGpx(text) {
    var name = (text.match(/<name>([^<]*)<\/name>/) || [])[1] || 'Trace importée';
    var re = /<(trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g, m, coords = [];
    while ((m = re.exec(text))) {
      var attrs = m[2];
      var lat = parseFloat((attrs.match(/lat="([^"]+)"/) || attrs.match(/lat='([^']+)'/) || [])[1]);
      var lon = parseFloat((attrs.match(/lon="([^"]+)"/) || attrs.match(/lon='([^']+)'/) || [])[1]);
      var ele = m[4] ? parseFloat((m[4].match(/<ele>([^<]+)<\/ele>/) || [])[1]) : NaN;
      if (!isNaN(lat) && !isNaN(lon)) coords.push([lat, lon, isNaN(ele) ? null : ele]);
    }
    name = name.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    return { name: name.trim(), coords: coords };
  }

  // Accès motos d'une voie OSM : 'interdit' | 'ok'
  var NO = /^(no|private|agricultural|forestry|agricultural;forestry|forestry;agricultural|permit|military)$/;
  var YES = /^(yes|permissive|designated|destination|customers|official)$/;
  function motoAccess(tags) {
    var keys = ['motorcycle', 'motor_vehicle', 'vehicle', 'access'];
    for (var i = 0; i < keys.length; i++) {
      var v = tags[keys[i]];
      if (v === undefined) continue;
      if (NO.test(v)) return 'interdit';
      if (YES.test(v)) return 'ok';
    }
    return 'ok';
  }

  var api = {
    haversine: haversine, cumulative: cumulative, parseTags: parseTags, surfaceClass: surfaceClass,
    parseBrouter: parseBrouter, fromCoords: fromCoords, computeAscend: computeAscend,
    unpavedShare: unpavedShare, estimateHours: estimateHours, sample: sample,
    locateOnRoute: locateOnRoute, fuelGaps: fuelGaps, buildGpx: buildGpx, parseGpx: parseGpx,
    motoAccess: motoAccess, CLASSES: CLASSES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PisteCore = api;
})(this);
