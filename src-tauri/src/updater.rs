// Mise à jour automatique de yt-dlp : YouTube change souvent, et un yt-dlp de plus de quelques
// semaines finit par échouer. Le binaire embarqué dans l'app (signé, en lecture seule) est copié
// dans le dossier de données de l'app, puis cette copie se met à jour elle-même (`yt-dlp -U`),
// au plus une fois par jour.

use crate::ytdlp;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const EXE: &str = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
const CHECK_EVERY: Duration = Duration::from_secs(24 * 3600);

/// Copie modifiable de yt-dlp dans le dossier de données de l'app.
pub fn managed_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bin").join(EXE)
}

fn stamp_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bin").join("derniere-verification")
}

/// Copie le yt-dlp embarqué s'il n'y a pas encore de copie, ou si l'app en apporte un plus récent.
/// Renvoie le chemin à utiliser (la copie si elle marche, sinon le binaire embarqué).
pub async fn prepare(bundled: &Path, data_dir: &Path) -> PathBuf {
    let copy = managed_path(data_dir);
    let bundled_v = ytdlp::version(bundled).await;
    let copy_v = if copy.exists() { ytdlp::version(&copy).await } else { None };
    let replace = match (&bundled_v, &copy_v) {
        (_, None) => bundled.exists(),
        (Some(b), Some(c)) => ytdlp::newer(b, c),
        (None, Some(_)) => false,
    };
    if replace {
        if let Err(e) = install_copy(bundled, &copy).await {
            eprintln!("[yt-dlp] copie impossible : {e}");
            return bundled.to_path_buf();
        }
        return copy;
    }
    if copy_v.is_some() {
        copy
    } else {
        bundled.to_path_buf()
    }
}

async fn install_copy(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(dir) = to.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    // copie à côté puis renommage : jamais de fichier à moitié écrit
    let tmp = to.with_extension("tmp");
    tokio::fs::copy(from, &tmp).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).await?;
    }
    tokio::fs::rename(&tmp, to).await
}

/// Faut-il vérifier les mises à jour (dernière vérification il y a plus d'un jour) ?
pub fn due(data_dir: &Path) -> bool {
    let modified = std::fs::metadata(stamp_path(data_dir)).and_then(|m| m.modified());
    match modified {
        Ok(t) => SystemTime::now().duration_since(t).map(|d| d >= CHECK_EVERY).unwrap_or(true),
        Err(_) => true,
    }
}

/// Lance `yt-dlp -U` sur la copie (si c'est bien elle qu'on utilise). Renvoie la nouvelle version.
pub async fn self_update(exe: &Path, data_dir: &Path, force: bool) -> Option<String> {
    if exe != managed_path(data_dir) || (!force && !due(data_dir)) {
        return None;
    }
    let _ = std::fs::write(stamp_path(data_dir), b"");
    let args = vec!["-U".to_string(), "--no-warnings".to_string()];
    match tokio::time::timeout(Duration::from_secs(180), ytdlp::run(exe, &args, |_| {}, None)).await {
        Ok(Ok(_)) => ytdlp::version(exe).await,
        Ok(Err(e)) => {
            eprintln!("[yt-dlp] mise à jour impossible : {}", e.message);
            None
        }
        Err(_) => {
            eprintln!("[yt-dlp] mise à jour trop longue, abandonnée");
            None
        }
    }
}
