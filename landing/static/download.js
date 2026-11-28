// Boutons de téléchargement : chaque bouton télécharge directement le fichier de la dernière version
// publiée (trouvé par son extension). Textes : window.LANDING (généré par build.mjs).
(function () {
  var L = window.LANDING;
  var T = L.t;
  var $ = function (s) { return document.querySelector(s); };
  var fmt = function (s, v) { return s.replace(/\{(\w+)\}/g, function (_, k) { return v[k]; }); };

  // fichier à proposer pour chaque appareil, par ordre de préférence
  var PATTERNS = {
    android: [/EnjoySing-android\.apk$/i, /\.apk$/i],
    mac: [/universal\.dmg$/i, /\.dmg$/i],
    windows: [/x64-setup\.exe$/i, /\.exe$/i, /\.msi$/i],
    linux: [/\.AppImage$/],
  };
  var NAMES = { android: 'Android', ios: 'iPhone', mac: 'Mac', windows: 'Windows', linux: 'Linux' };

  function detectOs() {
    var ua = navigator.userAgent;
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return null;
  }
  function size(b) { return Math.max(1, Math.round(b / 1e6)) + ' MB'; }
  function pick(assets, os) {
    var pats = PATTERNS[os] || [];
    for (var i = 0; i < pats.length; i++)
      for (var j = 0; j < assets.length; j++) if (pats[i].test(assets[j].name)) return assets[j];
    return null;
  }

  // ------------------------------------------------------------ votre appareil en premier
  var os = detectOs();
  var mine = os && document.querySelector('.device[data-os="' + os + '"]');
  if (mine) {
    mine.classList.add('mine');
    mine.parentNode.insertBefore(mine, mine.parentNode.firstChild);
    // le bouton du haut montre le logo de l'appareil
    var ic = mine.querySelector('.dev-icon svg');
    if (ic) $('#hero-cta-icon').innerHTML = ic.outerHTML;
  }

  // ------------------------------------------------------------ iPhone (TestFlight)
  if (L.testflight) {
    var tf = $('#testflight');
    tf.href = L.testflight;
    tf.textContent = T.iosBtnReady;
    tf.removeAttribute('aria-disabled');
  }

  function heroTo(href, text) {
    $('#hero-cta').href = href;
    $('#hero-cta-text').textContent = text;
  }
  if (os === 'ios' && L.testflight) heroTo(L.testflight, T.iosBtnReady);

  function soon() {
    $('#dl-status').textContent = T.dlSoon + ' — ' + T.dlSoonNote;
  }

  fetch('https://api.github.com/repos/' + L.repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then(function (rel) {
      var assets = rel.assets || [];
      var found = 0;
      Object.keys(PATTERNS).forEach(function (key) {
        var a = pick(assets, key);
        var btn = document.querySelector('[data-asset="' + key + '"]');
        if (!a || !btn) return;
        found++;
        btn.href = a.browser_download_url;
        btn.removeAttribute('aria-disabled');
        btn.textContent = T.btnDownload + ' · ' + size(a.size);
        if (key === os) heroTo(a.browser_download_url, fmt(T.downloadFor, { os: NAMES[os] }));
      });
      if (!found) return soon();
      $('#dl-status').textContent = fmt(T.dlVersion, { v: (rel.tag_name || '').replace(/^v/, '') });
    })
    .catch(soon);

  // ------------------------------------------------------------ langue
  // Anglais par défaut ; un visiteur francophone sur la page anglaise voit une proposition discrète.
  try {
    document.querySelectorAll('[data-lang-switch]').forEach(function (a) {
      a.addEventListener('click', function () { localStorage.setItem('enjoysing-lang', L.lang === 'en' ? 'fr' : 'en'); });
    });
    var chosen = localStorage.getItem('enjoysing-lang');
    var fr = (navigator.languages || [navigator.language]).some(function (l) { return /^fr\b/i.test(l || ''); });
    if (L.lang === 'en' && !chosen && fr) {
      var hint = document.createElement('div');
      hint.className = 'lang-hint';
      hint.innerHTML = '<a href="/fr/">Voir le site en français</a><button aria-label="Fermer">×</button>';
      hint.querySelector('a').addEventListener('click', function () { localStorage.setItem('enjoysing-lang', 'fr'); });
      hint.querySelector('button').addEventListener('click', function () {
        localStorage.setItem('enjoysing-lang', 'en');
        hint.remove();
      });
      document.body.appendChild(hint);
    }
  } catch (e) {
    /* stockage indisponible : sans importance */
  }
})();
