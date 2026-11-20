// App EnjoySing (Tauri v2). L'interface est l'app web (build Vite) ; ce code natif ajoute,
// sur ordinateur, le téléchargement de l'audio YouTube avec yt-dlp depuis la machine de l'utilisateur.

#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
pub mod updater;
#[cfg(desktop)]
pub mod ytdlp;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // opener : liens externes (YouTube…) ouverts dans le navigateur de l'utilisateur
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = desktop::setup(builder);
    builder
        .run(tauri::generate_context!())
        .expect("erreur au lancement d'EnjoySing");
}
