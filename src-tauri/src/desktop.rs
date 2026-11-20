// Commandes appelées par le fournisseur d'audio « tauri-desktop » (src/native/tauri.ts).

use crate::{updater, ytdlp};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{Channel, Response};
use tauri::{Manager, State};
use tokio::sync::{watch, OnceCell};

#[derive(Default)]
struct AppState {
    /// yt-dlp prêt à l'emploi (copie à jour dans le dossier de données, ou binaire embarqué).
    tools: OnceCell<ytdlp::Tools>,
    /// Téléchargements en cours : identifiant de requête -> signal d'annulation.
    jobs: Mutex<HashMap<String, watch::Sender<bool>>>,
    data_dir: Mutex<Option<PathBuf>>,
    cache_dir: Mutex<Option<PathBuf>>,
}

/// Message envoyé au front pendant un téléchargement.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
enum DownloadEvent {
    Progress { fraction: f64, label: String },
    Done { mime: String },
}

#[derive(Serialize)]
struct Status {
    version: Option<String>,
    path: String,
    deno: Option<String>,
}

const EXE_SUFFIX: &str = if cfg!(windows) { ".exe" } else { "" };

/// Programme embarqué (« sidecar ») : Tauri le place à côté de l'exécutable de l'app
/// (préfixe « enjoysing- » : pas de conflit dans /usr/bin avec un yt-dlp ou un Deno du système).
/// Les variables ENJOYSING_YTDLP / ENJOYSING_DENO permettent d'en utiliser d'autres (tests, dépannage).
fn sidecar(name: &str, env: &str) -> PathBuf {
    if let Some(p) = std::env::var_os(env) {
        return PathBuf::from(p);
    }
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    dir.join(format!("{name}{EXE_SUFFIX}"))
}

impl AppState {
    async fn tools(&self) -> &ytdlp::Tools {
        self.tools
            .get_or_init(|| async {
                let bundled = sidecar("enjoysing-yt-dlp", "ENJOYSING_YTDLP");
                let deno = sidecar("enjoysing-deno", "ENJOYSING_DENO");
                let data_dir = self.data_dir.lock().unwrap().clone();
                let ytdlp = match (&data_dir, std::env::var_os("ENJOYSING_YTDLP")) {
                    (Some(dir), None) => updater::prepare(&bundled, dir).await,
                    _ => bundled,
                };
                ytdlp::Tools { ytdlp, deno: deno.exists().then_some(deno) }
            })
            .await
    }
}

#[tauri::command]
async fn yt_info(state: State<'_, AppState>, video_id: String) -> Result<ytdlp::VideoInfo, String> {
    let tools = state.tools().await;
    ytdlp::fetch_info(tools, &video_id).await.map_err(|e| e.message)
}

#[tauri::command]
async fn yt_download(
    state: State<'_, AppState>,
    video_id: String,
    req_id: String,
    on_event: Channel<DownloadEvent>,
) -> Result<Response, String> {
    let (tx, rx) = watch::channel(false);
    state.jobs.lock().unwrap().insert(req_id.clone(), tx);
    let _ = on_event.send(DownloadEvent::Progress { fraction: 0.0, label: "Préparation de yt-dlp…".into() });
    let tools = state.tools().await.clone();
    let work = state
        .cache_dir
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(std::env::temp_dir)
        .join("telechargements");
    let result = ytdlp::download_audio(
        &tools,
        &video_id,
        &work,
        |fraction, label| {
            let _ = on_event.send(DownloadEvent::Progress { fraction, label: label.to_string() });
        },
        Some(rx),
    )
    .await;
    state.jobs.lock().unwrap().remove(&req_id);
    let audio = result.map_err(|e| e.message)?;
    let _ = on_event.send(DownloadEvent::Done { mime: audio.mime.to_string() });
    // octets bruts (ArrayBuffer côté front), sans passer par du JSON
    Ok(Response::new(audio.bytes))
}

#[tauri::command]
fn yt_cancel(state: State<'_, AppState>, req_id: String) {
    if let Some(tx) = state.jobs.lock().unwrap().remove(&req_id) {
        let _ = tx.send(true);
    }
}

#[tauri::command]
async fn ytdlp_status(state: State<'_, AppState>) -> Result<Status, String> {
    let tools = state.tools().await;
    Ok(Status {
        version: ytdlp::version(&tools.ytdlp).await,
        path: tools.ytdlp.display().to_string(),
        deno: tools.deno.as_ref().map(|d| d.display().to_string()),
    })
}

/// Mise à jour de yt-dlp demandée par l'utilisateur (sans attendre le délai d'un jour).
#[tauri::command]
async fn ytdlp_update(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let tools = state.tools().await;
    let Some(dir) = state.data_dir.lock().unwrap().clone() else { return Ok(None) };
    Ok(updater::self_update(&tools.ytdlp, &dir, true).await)
}

pub fn setup(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![yt_info, yt_download, yt_cancel, ytdlp_status, ytdlp_update])
        .setup(|app| {
            let state = app.state::<AppState>();
            *state.data_dir.lock().unwrap() = app.path().app_data_dir().ok();
            *state.cache_dir.lock().unwrap() = app.path().app_cache_dir().ok();
            // au démarrage, en arrière-plan : copie de yt-dlp puis vérification des mises à jour
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let tools = state.tools().await;
                let dir = state.data_dir.lock().unwrap().clone();
                if let Some(dir) = dir {
                    if let Some(v) = updater::self_update(&tools.ytdlp, &dir, false).await {
                        println!("[yt-dlp] version {v}");
                    }
                }
            });
            Ok(())
        })
}
