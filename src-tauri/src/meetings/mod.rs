pub mod capture;
pub mod commands;
pub mod license;
pub mod runtime;
pub mod storage;
pub mod summary;
pub mod transcript;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

pub static CAPTURE_GATE: Mutex<()> = Mutex::new(());
pub static CAPTURE_ACTIVE: AtomicBool = AtomicBool::new(false);
pub fn capture_active() -> bool {
    CAPTURE_ACTIVE.load(Ordering::SeqCst)
}

pub fn directory() -> Result<std::path::PathBuf, String> {
    let path = dirs::data_local_dir()
        .ok_or("Cannot find local application data")?
        .join("echo/meetings");
    std::fs::create_dir_all(&path).map_err(|_| "Could not create the local meeting library")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect the local meeting library")?;
    }
    Ok(path)
}

pub fn id_valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}
