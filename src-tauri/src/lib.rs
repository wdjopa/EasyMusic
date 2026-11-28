// App EnjoySing (Tauri v2). L'interface est l'app web (build Vite) ; ce code natif ajoute,
// sur ordinateur, le téléchargement de l'audio YouTube avec yt-dlp depuis la machine de l'utilisateur.

#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
pub mod updater;
#[cfg(desktop)]
pub mod ytdlp;

use tauri::webview::{PermissionKind, PermissionResponse};

#[cfg(mobile)]
mod netdiag;
#[cfg(mobile)]
mod androidhttp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // opener : liens externes (YouTube…) ouverts dans le navigateur de l'utilisateur
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // micro (getUserMedia : tessiture, vérifier mon jeu) : accordé à la page de l'app.
        // Sans cela WebKitGTK (Linux) refuse ; le système garde sa propre autorisation
        // (macOS : NSMicrophoneUsageDescription, Windows : paramètres de confidentialité).
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        });
    #[cfg(desktop)]
    let builder = desktop::setup(builder);
    // mobile : fetch par Rust pour récupérer l'audio YouTube depuis le téléphone (src/native/mobile.ts)
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![netdiag::diagnostic_reseau, androidhttp::http_natif]);
    // Android : requêtes par la pile réseau du téléphone, en secours du module HTTP de Rust
    #[cfg(target_os = "android")]
    let builder = builder.plugin(androidhttp::init());
    builder
        .run(tauri::generate_context!())
        .expect("erreur au lancement d'EnjoySing");
}
