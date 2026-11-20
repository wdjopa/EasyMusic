// Appels à yt-dlp depuis l'ordinateur de l'utilisateur (son adresse IP de particulier :
// YouTube ne le prend pas pour un robot, contrairement au serveur).
// Inspiré de server/youtube.ts : mêmes formats, mêmes stratégies de repli, mêmes messages d'erreur.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

/// Programmes utilisés : yt-dlp, et Deno (runtime JavaScript exigé par yt-dlp pour YouTube).
#[derive(Clone, Debug)]
pub struct Tools {
    pub ytdlp: PathBuf,
    pub deno: Option<PathBuf>,
}

/// Infos d'une vidéo (même forme que `fetchInfo` côté front).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct VideoInfo {
    pub title: String,
    pub author: String,
    pub duration: f64,
    pub thumbnail: String,
    /// Faux si le propriétaire interdit la lecture hors de YouTube.
    pub embeddable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ErrorKind {
    /// Refus de YouTube (403) : on peut réessayer avec une autre stratégie.
    Refused,
    /// Annulé par l'utilisateur.
    Cancelled,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DlError {
    pub kind: ErrorKind,
    pub message: String,
}

impl DlError {
    fn other(message: impl Into<String>) -> Self {
        DlError { kind: ErrorKind::Other, message: message.into() }
    }
    fn cancelled() -> Self {
        DlError { kind: ErrorKind::Cancelled, message: "annulé".into() }
    }
}

/// Identifiant YouTube : 11 caractères parmi [A-Za-z0-9_-] (empêche tout argument détourné).
pub fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}

/// Arguments communs : pas de playlist, configuration de l'utilisateur ignorée, Deno embarqué.
pub fn base_args(tools: &Tools) -> Vec<String> {
    let mut a: Vec<String> = ["--no-playlist", "--no-warnings", "--ignore-config"].iter().map(|s| s.to_string()).collect();
    if let Some(deno) = &tools.deno {
        a.push("--js-runtimes".into());
        a.push(format!("deno:{}", deno.display()));
    }
    a
}

/// Stratégies de téléchargement, essayées dans l'ordre en cas de refus (403).
/// AAC (m4a) d'abord : c'est le format que toutes les vues web (WebView2, WKWebView, WebKitGTK) décodent.
pub const STRATEGIES: &[(&str, &[&str])] = &[
    (
        "audio seul",
        &["-f", "bestaudio[ext=m4a][abr<=160]/bestaudio[ext=m4a]/bestaudio[abr<=160]/bestaudio/best"],
    ),
    ("vidéo basse qualité (format 18)", &["-f", "18/worst[acodec!=none]/best"]),
    (
        "autres clients YouTube",
        &["-f", "bestaudio[ext=m4a]/bestaudio/best", "--extractor-args", "youtube:player_client=tv,mweb,web_safari"],
    ),
];

/// Ligne de progression (« PROGRESS  42.1% ») -> fraction entre 0 et 1.
pub fn parse_progress(line: &str) -> Option<f64> {
    let rest = line.trim().strip_prefix("PROGRESS")?.trim();
    let num = rest.trim_end_matches('%').trim();
    num.parse::<f64>().ok().map(|p| (p / 100.0).clamp(0.0, 1.0))
}

/// Message compréhensible à partir du journal d'erreurs de yt-dlp.
pub fn friendly_error(stderr: &str) -> DlError {
    let low = stderr.to_lowercase();
    if low.contains("not a bot") || low.contains("sign in to confirm you") {
        return DlError::other(
            "YouTube demande une vérification anti-robot pour cette connexion. Réessayez plus tard ou changez de réseau.",
        );
    }
    if low.contains("http error 403") {
        return DlError {
            kind: ErrorKind::Refused,
            message: "YouTube a refusé le téléchargement (erreur 403). La mise à jour de yt-dlp corrige souvent ce problème.".into(),
        };
    }
    if low.contains("private video")
        || low.contains("video unavailable")
        || low.contains("this video is not available")
        || low.contains("removed")
    {
        return DlError::other("Vidéo indisponible ou privée.");
    }
    if low.contains("age") && low.contains("confirm") {
        return DlError::other("Vidéo soumise à une limite d’âge : impossible de l’analyser.");
    }
    if low.contains("no supported javascript runtime") || (low.contains("js runtime") && low.contains("not")) {
        return DlError::other("yt-dlp ne trouve pas de runtime JavaScript (Deno) : réinstallez l’application.");
    }
    let line = stderr.lines().filter(|l| l.starts_with("ERROR")).last();
    DlError::other(match line {
        Some(l) => l.trim_start_matches("ERROR:").trim().to_string(),
        None => "Téléchargement impossible.".to_string(),
    })
}

/// Type MIME d'après l'extension du fichier téléchargé.
pub fn mime_for(file: &Path) -> &'static str {
    match file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "m4a" | "aac" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "audio/webm",
        "opus" | "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// Prépare une commande sans fenêtre de console (Windows) ni configuration héritée.
pub fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    // yt-dlp (PyInstaller) écrit en UTF-8 même sous Windows
    c.env("PYTHONIOENCODING", "utf-8");
    c
}

/// Lance un programme (arguments en tableau : pas de shell, pas d'injection possible).
/// `on_line` reçoit chaque ligne de la sortie standard ; `cancel` passe à vrai pour tout arrêter.
pub async fn run(
    program: &Path,
    args: &[String],
    mut on_line: impl FnMut(&str),
    cancel: Option<watch::Receiver<bool>>,
) -> Result<Vec<u8>, DlError> {
    let mut child = command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                DlError::other(format!("Programme introuvable : {}", program.display()))
            } else {
                DlError::other(format!("Impossible de lancer {} : {e}", program.display()))
            }
        })?;
    let mut stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let err_task = tokio::spawn(async move {
        let mut s = Vec::new();
        let _ = stderr.read_to_end(&mut s).await;
        String::from_utf8_lossy(&s).into_owned()
    });
    let mut cancel = cancel;
    if cancel.as_ref().is_some_and(|c| *c.borrow()) {
        let _ = child.kill().await;
        return Err(DlError::cancelled());
    }
    let mut out = Vec::new();
    let mut partial = String::new();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        tokio::select! {
            n = stdout.read(&mut buf) => {
                let n = n.map_err(|e| DlError::other(e.to_string()))?;
                if n == 0 { break; }
                out.extend_from_slice(&buf[..n]);
                partial.push_str(&String::from_utf8_lossy(&buf[..n]));
                // lignes terminées par \n, \r\n ou \r (barre de progression)
                while let Some(i) = partial.find(['\n', '\r']) {
                    let line: String = partial.drain(..=i).collect();
                    let line = line.trim_end_matches(['\n', '\r']);
                    if !line.is_empty() { on_line(line); }
                }
            }
            _ = cancelled(&mut cancel) => {
                let _ = child.kill().await;
                return Err(DlError::cancelled());
            }
        }
    }
    let status = tokio::select! {
        s = child.wait() => s.map_err(|e| DlError::other(e.to_string()))?,
        _ = cancelled(&mut cancel) => {
            let _ = child.kill().await;
            return Err(DlError::cancelled());
        }
    };
    let err = err_task.await.unwrap_or_default();
    if status.success() {
        Ok(out)
    } else {
        Err(friendly_error(&err))
    }
}

/// Se termine quand l'annulation est demandée ; jamais s'il n'y a pas de signal (ou s'il a disparu).
async fn cancelled(cancel: &mut Option<watch::Receiver<bool>>) {
    if let Some(rx) = cancel {
        if rx.wait_for(|c| *c).await.is_ok() {
            return;
        }
    }
    std::future::pending::<()>().await
}

/// Infos de la vidéo (`yt-dlp -J`).
pub async fn fetch_info(tools: &Tools, id: &str) -> Result<VideoInfo, DlError> {
    if !valid_id(id) {
        return Err(DlError::other("Identifiant de vidéo invalide."));
    }
    let mut args = base_args(tools);
    args.extend(["-J".into(), "--".into(), watch_url(id)]);
    let out = run(&tools.ytdlp, &args, |_| {}, None).await?;
    parse_info(id, &out)
}

pub fn parse_info(id: &str, json: &[u8]) -> Result<VideoInfo, DlError> {
    let j: serde_json::Value =
        serde_json::from_slice(json).map_err(|_| DlError::other("Réponse de yt-dlp illisible."))?;
    let s = |k: &str| j.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(VideoInfo {
        title: s("title").unwrap_or_else(|| "Sans titre".into()),
        author: s("channel").or_else(|| s("uploader")).unwrap_or_default(),
        duration: j.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0),
        thumbnail: format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"),
        embeddable: j.get("playable_in_embed").and_then(|v| v.as_bool()) != Some(false),
    })
}

/// Audio téléchargé : octets et type MIME.
pub struct Audio {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

/// Télécharge l'audio dans `work_dir` (créé puis supprimé), en essayant les stratégies dans l'ordre.
pub async fn download_audio(
    tools: &Tools,
    id: &str,
    work_dir: &Path,
    mut on_progress: impl FnMut(f64, &str),
    cancel: Option<watch::Receiver<bool>>,
) -> Result<Audio, DlError> {
    if !valid_id(id) {
        return Err(DlError::other("Identifiant de vidéo invalide."));
    }
    let mut last: Option<DlError> = None;
    for (i, (label, strategy)) in STRATEGIES.iter().enumerate() {
        let dir = work_dir.join(format!("{id}-{i}"));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.map_err(|e| DlError::other(e.to_string()))?;
        if i > 0 {
            on_progress(0.0, &format!("Nouvel essai ({label})…"));
        }
        let mut args = base_args(tools);
        args.extend(strategy.iter().map(|s| s.to_string()));
        args.extend(
            [
                "--max-filesize", "120M",
                "--newline",
                "--progress-template", "download:PROGRESS %(progress._percent_str)s",
                "-o",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        args.push(dir.join("audio.%(ext)s").to_string_lossy().into_owned());
        args.push("--".into());
        args.push(watch_url(id));
        let result = run(
            &tools.ytdlp,
            &args,
            |line| {
                if let Some(f) = parse_progress(line) {
                    on_progress(f, &format!("Téléchargement de l’audio… {} %", (f * 100.0).round()));
                }
            },
            cancel.clone(),
        )
        .await;
        let outcome = match result {
            Ok(_) => read_audio(&dir).await,
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_dir_all(&dir).await;
        match outcome {
            Ok(a) => return Ok(a),
            Err(e) if e.kind == ErrorKind::Refused && i + 1 < STRATEGIES.len() => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| DlError::other("Téléchargement impossible.")))
}

async fn read_audio(dir: &Path) -> Result<Audio, DlError> {
    let mut entries = tokio::fs::read_dir(dir).await.map_err(|e| DlError::other(e.to_string()))?;
    while let Some(e) = entries.next_entry().await.map_err(|e| DlError::other(e.to_string()))? {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("audio.") && !name.ends_with(".part") && !name.ends_with(".ytdl") {
            let path = e.path();
            let bytes = tokio::fs::read(&path).await.map_err(|e| DlError::other(e.to_string()))?;
            return Ok(Audio { bytes, mime: mime_for(&path) });
        }
    }
    Err(DlError::other("Fichier audio introuvable après le téléchargement."))
}

/// Version de yt-dlp (« 2026.11.01 »), ou None s'il ne se lance pas.
pub async fn version(program: &Path) -> Option<String> {
    let out = run(program, &["--version".to_string()], |_| {}, None).await.ok()?;
    let v = String::from_utf8_lossy(&out).trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// Compare deux versions de yt-dlp (« 2026.11.01 », « 2026.11.01.123456 » pour les nightly).
pub fn newer(a: &str, b: &str) -> bool {
    let parse = |s: &str| s.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(a) > parse(b)
}
