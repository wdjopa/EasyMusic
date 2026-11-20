// Tests de la chaîne yt-dlp avec un FAUX yt-dlp (script shell) : YouTube n'est pas joignable
// depuis la CI. Même principe que tests/server.test.ts côté serveur.
#![cfg(unix)]

use enjoysing_lib::updater;
use enjoysing_lib::ytdlp::{self, ErrorKind, Tools};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const FAKE: &str = r#"#!/bin/sh
here=$(dirname "$0")
echo "$@" >> "$here/appels.log"
url=""; out=""; prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"; url="$a"
done
case " $* " in
  *" --version "*) cat "$here/version" 2>/dev/null || echo 2026.01.01; exit 0 ;;
  *" -U "*) echo 2026.12.31 > "$here/version"; echo "Updated yt-dlp to 2026.12.31"; exit 0 ;;
esac
case "$url" in
  *privvvvvvvv*) echo "ERROR: [youtube] privvvvvvvv: Private video" >&2; exit 1 ;;
  *robotrobotx*) echo "ERROR: [youtube] robotrobotx: Sign in to confirm you're not a bot" >&2; exit 1 ;;
  *toujours403*) echo "ERROR: unable to download video data: HTTP Error 403: Forbidden" >&2; exit 1 ;;
esac
case " $* " in
  *" -J "*) echo '{"title":"Chanson de test","channel":"Artiste","duration":16,"playable_in_embed":false}'; exit 0 ;;
esac
case "$url" in
  *refus403000*) case " $* " in *"18/worst"*) ;; *) echo "ERROR: [download] Got error: HTTP Error 403: Forbidden" >&2; exit 1 ;; esac ;;
  *lentlentlen*) echo "PROGRESS   5.0%"; sleep 30; exit 0 ;;
esac
for p in 10.0 50.0 100.0; do printf 'PROGRESS  %s%%\r' "$p"; done
file=$(echo "$out" | sed 's/%(ext)s/m4a/')
printf 'AUDIO-%s' "$url" > "$file"
"#;

struct Fake {
    _dir: tempfile::TempDir,
    root: PathBuf,
    exe: PathBuf,
}

fn fake() -> Fake {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let bin = root.join("bin-fourni");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("yt-dlp");
    std::fs::write(&exe, FAKE).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    Fake { _dir: dir, root, exe }
}

fn tools(exe: &Path) -> Tools {
    Tools { ytdlp: exe.to_path_buf(), deno: Some(PathBuf::from("/chemin/vers/deno")) }
}

fn calls(exe: &Path) -> String {
    std::fs::read_to_string(exe.parent().unwrap().join("appels.log")).unwrap_or_default()
}

#[tokio::test]
async fn telecharge_avec_progression_et_deno() {
    let f = fake();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let audio = ytdlp::download_audio(&tools(&f.exe), "dQw4w9WgXcQ", &f.root.join("travail"), move |p, _| s.lock().unwrap().push(p), None)
        .await
        .unwrap();
    assert_eq!(audio.mime, "audio/mp4");
    assert_eq!(audio.bytes, b"AUDIO-https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert_eq!(*seen.lock().unwrap(), vec![0.1, 0.5, 1.0]);
    let log = calls(&f.exe);
    assert!(log.contains("--js-runtimes deno:/chemin/vers/deno"), "{log}");
    assert!(log.contains("bestaudio[ext=m4a]"), "{log}");
    assert!(log.contains("--ignore-config"));
    // le dossier de travail est nettoyé
    assert_eq!(std::fs::read_dir(f.root.join("travail")).unwrap().count(), 0);
}

#[tokio::test]
async fn repli_sur_le_format_18_apres_un_refus_403() {
    let f = fake();
    let audio = ytdlp::download_audio(&tools(&f.exe), "refus403000", &f.root.join("t"), |_, _| {}, None).await.unwrap();
    assert!(!audio.bytes.is_empty());
    assert_eq!(calls(&f.exe).lines().count(), 2);
}

#[tokio::test]
async fn erreurs_comprehensibles() {
    let f = fake();
    let t = tools(&f.exe);
    let e = ytdlp::download_audio(&t, "privvvvvvvv", &f.root.join("t"), |_, _| {}, None).await.err().unwrap();
    assert_eq!(e.message, "Vidéo indisponible ou privée.");
    let e = ytdlp::download_audio(&t, "robotrobotx", &f.root.join("t"), |_, _| {}, None).await.err().unwrap();
    assert!(e.message.contains("anti-robot"));
    // 403 partout : les trois stratégies sont essayées, puis l'erreur est remontée
    let e = ytdlp::download_audio(&t, "toujours403", &f.root.join("t"), |_, _| {}, None).await.err().unwrap();
    assert_eq!(e.kind, ErrorKind::Refused);
    assert!(calls(&f.exe).contains("player_client=tv"));
    // identifiant détourné : refusé avant tout appel
    let e = ytdlp::download_audio(&t, "--exec=rm -rf", &f.root.join("t"), |_, _| {}, None).await.err().unwrap();
    assert!(e.message.contains("invalide"));
    let missing = Tools { ytdlp: f.root.join("absent"), deno: None };
    let e = ytdlp::fetch_info(&missing, "dQw4w9WgXcQ").await.err().unwrap();
    assert!(e.message.contains("introuvable"), "{}", e.message);
}

#[tokio::test]
async fn infos_de_la_video() {
    let f = fake();
    let info = ytdlp::fetch_info(&tools(&f.exe), "dQw4w9WgXcQ").await.unwrap();
    assert_eq!(info.title, "Chanson de test");
    assert_eq!(info.author, "Artiste");
    assert_eq!(info.duration, 16.0);
    assert!(!info.embeddable);
    assert_eq!(info.thumbnail, "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
}

#[tokio::test]
async fn annulation() {
    let f = fake();
    let (tx, rx) = tokio::sync::watch::channel(false);
    let t = tools(&f.exe);
    let work = f.root.join("t");
    let start = std::time::Instant::now();
    let task = tokio::spawn(async move { ytdlp::download_audio(&t, "lentlentlen", &work, |_, _| {}, Some(rx)).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    tx.send(true).unwrap();
    let r = tokio::time::timeout(Duration::from_secs(5), task).await.expect("annulation trop lente").unwrap();
    assert_eq!(r.err().unwrap().kind, ErrorKind::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn copie_et_mise_a_jour_de_yt_dlp() {
    let f = fake();
    let data = f.root.join("donnees");
    // première fois : copie dans le dossier de données
    let exe = updater::prepare(&f.exe, &data).await;
    assert_eq!(exe, updater::managed_path(&data));
    assert_eq!(ytdlp::version(&exe).await.as_deref(), Some("2026.01.01"));
    assert!(updater::due(&data));
    // mise à jour : la copie se met à jour, l'original embarqué ne change pas
    let v = updater::self_update(&exe, &data, false).await;
    assert_eq!(v.as_deref(), Some("2026.12.31"));
    assert!(!updater::due(&data), "pas de nouvelle vérification avant un jour");
    assert_eq!(updater::self_update(&exe, &data, false).await, None);
    // la copie, plus récente, est gardée
    assert_eq!(updater::prepare(&f.exe, &data).await, exe);
    // l'original embarqué n'est jamais mis à jour lui-même
    assert_eq!(updater::self_update(&f.exe, &data, true).await, None);
}

#[test]
fn utilitaires() {
    assert_eq!(ytdlp::parse_progress("PROGRESS  42.5%"), Some(0.425));
    assert_eq!(ytdlp::parse_progress("PROGRESS 100%"), Some(1.0));
    assert_eq!(ytdlp::parse_progress("[download] truc"), None);
    assert!(ytdlp::valid_id("dQw4w9WgXcQ"));
    assert!(!ytdlp::valid_id("dQw4w9WgXc"));
    assert!(!ytdlp::valid_id("-J --exec x"));
    assert!(ytdlp::newer("2026.11.01", "2026.10.26"));
    assert!(ytdlp::newer("2026.10.26.1234", "2026.10.26"));
    assert!(!ytdlp::newer("2026.10.26", "2026.10.26"));
    assert_eq!(ytdlp::mime_for(Path::new("a.webm")), "audio/webm");
    let info = ytdlp::parse_info("abcdefghijk", br#"{"uploader":"U"}"#).unwrap();
    assert_eq!((info.title.as_str(), info.author.as_str(), info.embeddable), ("Sans titre", "U", true));
}
