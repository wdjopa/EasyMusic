//! Requêtes HTTP par la pile réseau d'Android (secours du module HTTP de Rust), voir
//! gen/android/…/NativeHttpPlugin.kt. Sur iOS, la commande répond « indisponible ».

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

#[derive(Serialize, Deserialize)]
pub struct Requete {
    url: String,
    method: String,
    /// paires [nom, valeur]
    headers: Vec<(String, String)>,
    /// corps en base64, absent pour un GET
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct Reponse {
    status: u16,
    url: String,
    headers: Vec<(String, String)>,
    /// corps en base64
    body: String,
}

#[cfg(target_os = "android")]
pub struct HttpNatif<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// Module interne qui enregistre la classe Kotlin.
#[cfg(target_os = "android")]
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri::Manager;
    tauri::plugin::Builder::new("httpnatif")
        .setup(|app, api| {
            let handle = api.register_android_plugin("me.resub.enjoysing", "NativeHttpPlugin")?;
            app.manage(HttpNatif(handle));
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn http_natif<R: Runtime>(app: AppHandle<R>, req: Requete) -> Result<Reponse, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let state = app.state::<HttpNatif<R>>();
        state.0.run_mobile_plugin_async("fetch", req).await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, req);
        Err("requêtes Android indisponibles sur cette plateforme".into())
    }
}
