// Liens de téléchargement : fichiers de la DERNIÈRE VERSION PUBLIÉE sur GitHub (releases), trouvés par leur
// extension. La page n'a donc pas à changer à chaque version. Textes : window.LANDING (généré par build.mjs).
(function () {
  var L = window.LANDING;
  var T = L.t;
  var fmt = function (s, vars) {
    return s.replace(/\{(\w+)\}/g, function (_, k) { return vars[k]; });
  };
  var $ = function (s) { return document.querySelector(s); };

  var PATTERNS = {
    android: [/EnjoySing-android\.apk$/i, /\.apk$/i],
    windows: [/x64-setup\.exe$/i, /\.exe$/i],
    'windows-msi': [/\.msi$/i],
    mac: [/universal\.dmg$/i, /\.dmg$/i],
    'linux-appimage': [/\.AppImage$/],
    'linux-deb': [/\.deb$/i],
    'linux-rpm': [/\.rpm$/i],
  };
  var OS_NAMES = { android: 'Android', ios: 'iPhone', windows: 'Windows', mac: 'macOS', linux: 'Linux' };
  var PRIMARY = { android: 'android', windows: 'windows', mac: 'mac', linux: 'linux-appimage' };

  function detectOs() {
    var ua = navigator.userAgent;
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
    return null;
  }
  function size(bytes) {
    return bytes > 1e6 ? Math.round(bytes / 1e6) + ' MB' : Math.max(1, Math.round(bytes / 1e3)) + ' kB';
  }
  function pick(assets, key) {
    var pats = PATTERNS[key];
    for (var i = 0; i < pats.length; i++)
      for (var j = 0; j < assets.length; j++) if (pats[i].test(assets[j].name)) return assets[j];
    return null;
  }

  // ------------------------------------------------------------ votre appareil en premier
  var os = detectOs();
  if (os) {
    var mine = document.querySelector('.card[data-os="' + os + '"]');
    if (mine) {
      mine.classList.add('mine');
      mine.parentNode.insertBefore(mine, mine.parentNode.firstChild);
    }
  }

  // ------------------------------------------------------------ iPhone : TestFlight
  if (L.testflight) {
    var tf = $('#testflight');
    tf.href = L.testflight;
    tf.textContent = T.iosBtnReady;
    tf.removeAttribute('aria-disabled');
  }

  var status = $('#status');
  function suggest(href, text, note) {
    $('#suggest-btn').href = href;
    $('#suggest-btn').textContent = text;
    $('#suggest-note').textContent = note || '';
    $('#suggest').hidden = false;
    var hero = $('#hero-cta');
    if (hero && href.indexOf('http') === 0) hero.textContent = text; // « Télécharger pour Windows »
  }
  function iosSuggest() {
    if (L.testflight) suggest(L.testflight, T.iosBtnReady);
  }

  function noFiles(msg) {
    status.textContent = msg;
    document.querySelectorAll('[data-asset].primary').forEach(function (a) { a.textContent = T.soon; });
    if (os === 'ios') iosSuggest();
  }

  fetch('https://api.github.com/repos/' + L.repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) {
      if (r.status === 404) throw new Error('none');
      if (!r.ok) throw new Error('http');
      return r.json();
    })
    .then(function (rel) {
      var assets = rel.assets || [];
      var found = 0;
      Object.keys(PATTERNS).forEach(function (key) {
        var a = pick(assets, key);
        document.querySelectorAll('[data-asset="' + key + '"]').forEach(function (el) {
          if (!a) {
            if (el.classList.contains('primary')) el.textContent = T.notInRelease;
            return;
          }
          found++;
          el.href = a.browser_download_url;
          el.hidden = false;
          el.removeAttribute('aria-disabled');
          el.title = a.name + ' · ' + size(a.size);
        });
      });
      if (!found) return noFiles(T.statusEmpty);

      var v = (rel.tag_name || '').replace(/^v/, '');
      var line = fmt(T.statusVersion, { v: v });
      if (rel.published_at) {
        var d = new Date(rel.published_at).toLocaleDateString(L.lang, { day: 'numeric', month: 'long', year: 'numeric' });
        line += ' · ' + fmt(T.statusPublished, { d: d });
      }
      status.textContent = line;
      if (rel.html_url) $('#all-files').href = rel.html_url;

      if (os === 'ios') iosSuggest();
      else if (os && PRIMARY[os]) {
        var a = pick(assets, PRIMARY[os]);
        if (a) suggest(a.browser_download_url, fmt(T.downloadFor, { os: OS_NAMES[os] }), a.name + ' · ' + size(a.size));
      }
    })
    .catch(function (e) {
      noFiles(e.message === 'none' ? T.statusNone : T.statusError);
    });

  // ------------------------------------------------------------ langue
  // Anglais par défaut. Un visiteur francophone sur la page anglaise voit une proposition discrète.
  try {
    document.querySelectorAll('[data-lang-switch]').forEach(function (a) {
      a.addEventListener('click', function () {
        localStorage.setItem('enjoysing-lang', L.lang === 'en' ? 'fr' : 'en');
      });
    });
    var chosen = localStorage.getItem('enjoysing-lang');
    var browserFr = (navigator.languages || [navigator.language]).some(function (l) { return /^fr\b/i.test(l || ''); });
    if (L.lang === 'en' && !chosen && browserFr) {
      var hint = document.createElement('div');
      hint.className = 'lang-hint';
      hint.innerHTML = '<span>🇫🇷</span> <a href="/fr/" data-lang-switch>Voir le site en français</a> <button aria-label="Fermer">×</button>';
      hint.querySelector('a').addEventListener('click', function () { localStorage.setItem('enjoysing-lang', 'fr'); });
      hint.querySelector('button').addEventListener('click', function () {
        localStorage.setItem('enjoysing-lang', 'en');
        hint.remove();
      });
      document.body.appendChild(hint);
    }
  } catch (e) {
    /* stockage indisponible (navigation privée) : rien de grave */
  }
})();
