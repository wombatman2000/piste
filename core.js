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
    var r = finish(coords, segs, total, parseFloat(props['filtered ascend']));
    r.hints = (props.voicehints || []).map(function (h) {
      return { idx: h[0], cmd: h[1], exit: h[2], angle: h[4] };
    }).filter(function (h) { return h.idx > 0 && h.idx < coords.length; });
    return r;
  }

  // Assemble plusieurs réponses BRouter (une par étape) en une seule
  function mergeBrouter(jsons) {
    if (jsons.length === 1) return jsons[0];
    var coords = [], msgs = null, len = 0, asc = 0, hints = [];
    jsons.forEach(function (j, k) {
      var f = j.features[0], c = f.geometry.coordinates, p = f.properties || {};
      var off = k === 0 ? 0 : coords.length - 1;
      (p.voicehints || []).forEach(function (h) { var x = h.slice(); x[0] += off; hints.push(x); });
      coords = coords.concat(k === 0 ? c : c.slice(1));
      len += parseFloat(p['track-length']) || 0;
      asc += parseFloat(p['filtered ascend']) || 0;
      var m = p.messages || [];
      if (!msgs) msgs = m.slice(); else msgs = msgs.concat(m.slice(1));
    });
    return { type: 'FeatureCollection', features: [{ type: 'Feature',
      properties: { 'track-length': String(len), 'filtered ascend': String(asc), messages: msgs || [], voicehints: hints },
      geometry: { type: 'LineString', coordinates: coords } }] };
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

  // Point à distM mètres de p dans la direction bearing (degrés, 0 = nord)
  function destination(p, bearing, distM) {
    var d = distM / R, b = rad(bearing), la = rad(p[0]), lo = rad(p[1]);
    var la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    var lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [la2 * 180 / Math.PI, ((lo2 * 180 / Math.PI) + 540) % 360 - 180];
  }

  // Petit générateur pseudo-aléatoire reproductible
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // Facteur moyen entre distance à vol d'oiseau et distance roulée, selon la dose de TT
  var DETOUR = { 1: 1.25, 2: 1.4, 3: 1.65 };

  // Rayon du cercle pour viser distM (polygone à n côtés, départ compris)
  function loopRadius(distM, n, level, factor) {
    return distM / (2 * n * Math.sin(Math.PI / n) * (factor || DETOUR[level] || 1.35));
  }

  // Points de passage d'une boucle : départ, n-1 points sur un cercle décalé vers bearing, retour au départ
  function loopWaypoints(start, bearing, radius, n, seed) {
    var rand = rng(seed || 1);
    var center = destination(start, bearing, radius);
    var back = (bearing + 180) % 360; // direction du départ vu depuis le centre
    var dir = rand() < 0.5 ? 1 : -1;  // sens horaire ou anti-horaire
    var pts = [start.slice(0, 2)];
    for (var i = 1; i < n; i++) {
      var a = back + dir * (360 / n) * i + (rand() - 0.5) * (220 / n);
      var rr = radius * (0.85 + rand() * 0.3);
      pts.push(destination(center, a, rr));
    }
    pts.push(start.slice(0, 2));
    return pts;
  }

  var BEARINGS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SO: 225, O: 270, NO: 315 };

  // Déplace chaque point intermédiaire au milieu du chemin autorisé le plus proche
  // ways : [{id, tags, coords:[[lat,lng],...]}] ; maxDist en mètres
  function snapToTracks(wps, ways, maxDist, opts) {
    opts = opts || {};
    var minLen = opts.minLen || 400;
    var cands = [];
    ways.forEach(function (w) {
      if (motoAccess(w.tags || {}) === 'interdit') return;
      var cls = surfaceClass(w.tags || {});
      if (cls === 'revetu') return;
      if (opts.noGrade5 && (w.tags || {}).tracktype === 'grade5') return;
      var cum = cumulative(w.coords), len = cum[cum.length - 1];
      if (len < minLen) return;
      var mid = 0;
      while (mid < cum.length - 1 && cum[mid] < len / 2) mid++;
      cands.push({ id: w.id, pt: w.coords[mid], len: len });
    });
    var used = {};
    return wps.map(function (p, i) {
      if (i === 0 || i === wps.length - 1) return p;
      var best = null, bestScore = Infinity;
      cands.forEach(function (c) {
        if (used[c.id]) return;
        var d = haversine(p, c.pt);
        if (d > maxDist) return;
        var score = d - Math.min(c.len, 3000) * 0.3; // préfère les chemins longs
        if (score < bestScore) { bestScore = score; best = c; }
      });
      if (!best) return p;
      used[best.id] = 1;
      return [best.pt[0], best.pt[1]];
    });
  }


  /* ---------- Navigation ---------- */

  function bearingTo(a, b) {
    var la1 = rad(a[0]), la2 = rad(b[0]), dl = rad(b[1] - a[1]);
    var y = Math.sin(dl) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function angleDiff(a, b) { var d = ((b - a + 540) % 360) - 180; return d; }

  // Point du parcours situé à la distance d (m) depuis le départ
  function pointAt(r, d) {
    var c = r.coords, cum = r.cum;
    if (d <= 0) return c[0];
    if (d >= r.length) return c[c.length - 1];
    var lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    var seg = cum[hi] - cum[lo] || 1, t = (d - cum[lo]) / seg;
    return [c[lo][0] + (c[hi][0] - c[lo][0]) * t, c[lo][1] + (c[hi][1] - c[lo][1]) * t];
  }

  // Projection d'un point sur un segment (approximation plane locale, précise à quelques m)
  function projSeg(p, a, b) {
    var k = Math.cos(rad(p[0])), ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0], px = p[1] * k, py = p[0];
    var dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    var t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    var q = [ay + dy * t, (ax + dx * t) / k];
    return { t: t, q: q, d: haversine(p, q) };
  }

  // Position sur le parcours, recherchée entre fromM et toM (m depuis le départ)
  function project(r, p, fromM, toM) {
    var c = r.coords, cum = r.cum, best = null;
    for (var i = 0; i < c.length - 1; i++) {
      if (cum[i + 1] < fromM) continue;
      if (cum[i] > toM) break;
      var pr = projSeg(p, c[i], c[i + 1]);
      if (!best || pr.d < best.off) best = { off: pr.d, at: cum[i] + (cum[i + 1] - cum[i]) * pr.t, seg: i, q: pr.q };
    }
    return best;
  }

  // Suivi : garde une progression cohérente (utile pour les boucles où départ = arrivée)
  function track(r, p, lastAt) {
    var near = project(r, p, Math.max(0, lastAt - 150), lastAt + 2500);
    if (near && near.off < 45) return near;
    var all = project(r, p, 0, Infinity);
    if (all && all.off < 35) {
      var jumpsToEnd = lastAt < 1500 && all.at > r.length - 3000;
      if (!jumpsToEnd) return all;
    }
    return near || all;
  }

  var CMD = { 1: 'straight', 2: 'left', 3: 'slight-left', 4: 'sharp-left', 5: 'right', 6: 'slight-right', 7: 'sharp-right',
    8: 'keep-left', 9: 'keep-right', 10: 'uturn', 11: 'uturn', 13: 'roundabout', 14: 'roundabout', 15: 'uturn', 17: 'exit-left', 18: 'exit-right' };
  var TEXT = { 'straight': 'Continuez tout droit', 'left': 'Tournez à gauche', 'slight-left': 'Prenez légèrement à gauche',
    'sharp-left': 'Tournez franchement à gauche', 'right': 'Tournez à droite', 'slight-right': 'Prenez légèrement à droite',
    'sharp-right': 'Tournez franchement à droite', 'keep-left': 'Serrez à gauche', 'keep-right': 'Serrez à droite',
    'uturn': 'Faites demi-tour', 'exit-left': 'Prenez la sortie à gauche', 'exit-right': 'Prenez la sortie à droite', 'arrive': 'Vous êtes arrivé' };
  var ORD = ['', 'première', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième'];

  function instrText(ins) {
    if (ins.type === 'roundabout') return 'Au rond-point, prenez la ' + (ORD[ins.exit] || ins.exit + 'e') + ' sortie';
    return TEXT[ins.type] || 'Continuez';
  }

  // Consignes à partir des indications BRouter, sinon d'après la géométrie
  function buildInstructions(r) {
    var out = [];
    if (r.hints && r.hints.length) {
      r.hints.forEach(function (h) {
        var type = CMD[h.cmd]; if (!type || type === 'straight') return;
        out.push({ at: r.cum[h.idx], type: type, exit: h.exit });
      });
    } else {
      out = geomTurns(r);
    }
    out.sort(function (a, b) { return a.at - b.at; });
    out.push({ at: r.length, type: 'arrive' });
    return out;
  }

  // Virages déduits de la trace (traces GPX importées) : cap mesuré 30 m avant et après
  function geomTurns(r) {
    var out = [], lastAt = -Infinity, step = 30;
    for (var d = step; d < r.length - step; d += 10) {
      var a = pointAt(r, d - step), m = pointAt(r, d), b = pointAt(r, d + step);
      var diff = angleDiff(bearingTo(a, m), bearingTo(m, b));
      var ad = Math.abs(diff);
      if (ad < 40 || d - lastAt < 80) continue;
      var side = diff < 0 ? 'left' : 'right';
      var type = ad > 150 ? 'uturn' : ad > 110 ? 'sharp-' + side : ad > 60 ? side : 'slight-' + side;
      out.push({ at: d, type: type });
      lastAt = d;
    }
    return out;
  }

  // Annonce vocale arrondie
  function sayDist(m) {
    if (m < 1000) { var r = m < 100 ? 10 : 50; return Math.max(r, Math.round(m / r) * r) + ' mètres'; }
    var km = Math.round(m / 100) / 10; return String(km).replace('.', ',') + ' kilomètre' + (km >= 2 ? 's' : '');
  }

  // Tuiles (x, y) couvrant un couloir autour du parcours
  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2y(lat, z) { var l = rad(lat); return Math.floor((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2 * Math.pow(2, z)); }
  function corridorTiles(r, zooms, widthM) {
    var tiles = {}, list = [];
    for (var d = 0; d <= r.length; d += Math.max(50, widthM / 2)) {
      var p = pointAt(r, d);
      var n = destination(p, 0, widthM), s = destination(p, 180, widthM), e = destination(p, 90, widthM), w = destination(p, 270, widthM);
      zooms.forEach(function (z) {
        for (var x = lon2x(w[1], z); x <= lon2x(e[1], z); x++)
          for (var y = lat2y(n[0], z); y <= lat2y(s[0], z); y++) {
            var k = z + '/' + x + '/' + y;
            if (!tiles[k]) { tiles[k] = 1; list.push({ z: z, x: x, y: y }); }
          }
      });
    }
    return list;
  }

  var api = {
    mergeBrouter: mergeBrouter, bearingTo: bearingTo, angleDiff: angleDiff, pointAt: pointAt, project: project, track: track,
    buildInstructions: buildInstructions, geomTurns: geomTurns, instrText: instrText, sayDist: sayDist, corridorTiles: corridorTiles, snapToTracks: snapToTracks, destination: destination, loopRadius: loopRadius, loopWaypoints: loopWaypoints, BEARINGS: BEARINGS,
    haversine: haversine, cumulative: cumulative, parseTags: parseTags, surfaceClass: surfaceClass,
    parseBrouter: parseBrouter, fromCoords: fromCoords, computeAscend: computeAscend,
    unpavedShare: unpavedShare, estimateHours: estimateHours, sample: sample,
    locateOnRoute: locateOnRoute, fuelGaps: fuelGaps, buildGpx: buildGpx, parseGpx: parseGpx,
    motoAccess: motoAccess, CLASSES: CLASSES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PisteCore = api;
})(this);
