use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const STATUS_EVENT: &str = "ship://status";
const FIRST_CHECK: Duration = Duration::from_secs(5);
const EVERY: Duration = Duration::from_secs(60 * 60);
const FOCUS_GAP: Duration = Duration::from_secs(10 * 60);
const PROGRESS_GAP: Duration = Duration::from_millis(200);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    Downloading,
    Ready,
    Installing,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub current: String,
    pub phase: Phase,
    pub available: Option<Available>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub last_check: Option<u64>,
    pub error: Option<String>,
}

type Hook = Arc<dyn Fn(&AppHandle) + Send + Sync>;

struct Ready {
    update: Update,
    bytes: Arc<Vec<u8>>,
    available: Available,
}

struct Ship {
    status: Mutex<Status>,
    ready: Mutex<Option<Ready>>,
    checked_at: Mutex<Option<Instant>>,
    busy: AtomicBool,
    before_install: Hook,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut Status)) -> Status {
    let snapshot = {
        let ship = app.state::<Ship>();
        let mut status = lock(&ship.status);
        f(&mut status);
        status.clone()
    };
    let _ = app.emit(STATUS_EVENT, &snapshot);
    snapshot
}

fn ready_info(app: &AppHandle) -> Option<Available> {
    lock(&app.state::<Ship>().ready)
        .as_ref()
        .map(|r| r.available.clone())
}

async fn fetch(app: &AppHandle) -> Result<Option<Available>, String> {
    let hook = app.state::<Ship>().before_install.clone();
    let hook_app = app.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || hook(&hook_app))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        *lock(&app.state::<Ship>().ready) = None;
        return Ok(None);
    };
    let available = Available {
        version: update.version.clone(),
        notes: update.body.clone().filter(|n| !n.trim().is_empty()),
    };
    if ready_info(app).is_some_and(|r| r.version == available.version) {
        return Ok(Some(available));
    }
    set_status(app, |s| {
        s.phase = Phase::Downloading;
        s.available = Some(available.clone());
        s.downloaded = 0;
        s.total = None;
    });
    let progress_app = app.clone();
    let mut downloaded = 0u64;
    let mut shown: Option<Instant> = None;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                if shown.is_none_or(|t| t.elapsed() >= PROGRESS_GAP) {
                    shown = Some(Instant::now());
                    set_status(&progress_app, |s| {
                        s.downloaded = downloaded;
                        s.total = total;
                    });
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    *lock(&app.state::<Ship>().ready) = Some(Ready {
        update,
        bytes: Arc::new(bytes),
        available: available.clone(),
    });
    Ok(Some(available))
}

async fn run_check(app: &AppHandle) {
    let ship = app.state::<Ship>();
    if ship.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    *lock(&ship.checked_at) = Some(Instant::now());
    set_status(app, |s| {
        if s.phase == Phase::Idle {
            s.phase = Phase::Checking;
        }
    });
    let outcome = fetch(app).await;
    let ready = ready_info(app);
    set_status(app, |s| {
        s.last_check = Some(now_ms());
        s.downloaded = 0;
        s.total = None;
        s.phase = if ready.is_some() {
            Phase::Ready
        } else {
            Phase::Idle
        };
        match outcome {
            Ok(found) => {
                s.error = None;
                s.available = found;
            }
            Err(e) => {
                s.error = Some(e);
                if ready.is_some() {
                    s.available = ready;
                }
            }
        }
    });
    ship.busy.store(false, Ordering::SeqCst);
}

fn checked_long_ago(app: &AppHandle, gap: Duration) -> bool {
    lock(&app.state::<Ship>().checked_at).is_some_and(|t| t.elapsed() >= gap)
}

#[tauri::command]
fn status(app: AppHandle) -> Status {
    lock(&app.state::<Ship>().status).clone()
}

#[tauri::command]
async fn check(app: AppHandle) -> Status {
    run_check(&app).await;
    status(app)
}

#[tauri::command]
async fn install(app: AppHandle) -> Result<(), String> {
    let (update, bytes) = {
        let ship = app.state::<Ship>();
        let ready = lock(&ship.ready);
        let ready = ready
            .as_ref()
            .ok_or_else(|| "No update is ready yet".to_string())?;
        (ready.update.clone(), ready.bytes.clone())
    };
    set_status(&app, |s| {
        s.phase = Phase::Installing;
        s.error = None;
    });
    let message = match tauri::async_runtime::spawn_blocking(move || {
        update.install(bytes.as_slice())
    })
    .await
    {
        Ok(Ok(())) => return Ok(()),
        Ok(Err(e)) => e.to_string(),
        Err(e) => e.to_string(),
    };
    set_status(&app, |s| {
        s.phase = Phase::Ready;
        s.error = Some(message.clone());
    });
    Err(message)
}

pub fn init<F>(before_install: F) -> TauriPlugin<Wry>
where
    F: Fn(&AppHandle) + Send + Sync + 'static,
{
    let hook: Hook = Arc::new(before_install);
    Builder::new("ship")
        .invoke_handler(tauri::generate_handler![status, check, install])
        .setup(move |app, _api| {
            app.manage(Ship {
                status: Mutex::new(Status {
                    current: app.package_info().version.to_string(),
                    ..Status::default()
                }),
                ready: Mutex::new(None),
                checked_at: Mutex::new(None),
                busy: AtomicBool::new(false),
                before_install: hook,
            });
            cleanup_installers(app);
            if !cfg!(debug_assertions) {
                let handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(FIRST_CHECK);
                    loop {
                        tauri::async_runtime::block_on(run_check(&handle));
                        std::thread::sleep(EVERY);
                    }
                });
            }
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::WindowEvent {
                event: WindowEvent::Focused(true),
                ..
            } = event
            {
                if checked_long_ago(app, FOCUS_GAP) {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move { run_check(&handle).await });
                }
            }
        })
        .build()
}

fn is_leftover(name: &str, app_name: &str) -> bool {
    name.strip_prefix(app_name)
        .and_then(|rest| rest.strip_prefix('-'))
        .is_some_and(|rest| rest.contains("-updater-"))
}

fn remove_leftovers(temp: &Path, app_name: &str) -> usize {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return 0;
    };
    let mut left = 0;
    for entry in entries.flatten() {
        if !is_leftover(&entry.file_name().to_string_lossy(), app_name) {
            continue;
        }
        if std::fs::remove_dir_all(entry.path()).is_err() {
            left += 1;
        }
    }
    left
}

fn cleanup_installers(app: &AppHandle) {
    let app_name = app.package_info().name.clone();
    std::thread::spawn(move || {
        let temp = std::env::temp_dir();
        for _ in 0..6 {
            if remove_leftovers(&temp, &app_name) == 0 {
                return;
            }
            std::thread::sleep(Duration::from_secs(10));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_own_updater_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let own = temp.path().join("Echo Studio-0.5.0-updater-Ab12Cd");
        std::fs::create_dir(&own).unwrap();
        std::fs::write(own.join("Echo Studio-0.5.0-installer.exe"), b"x").unwrap();
        let other = temp.path().join("Booked-1.0.0-updater-Xy");
        std::fs::create_dir(&other).unwrap();
        let plain = temp.path().join("Echo Studio-cache");
        std::fs::create_dir(&plain).unwrap();

        assert_eq!(remove_leftovers(temp.path(), "Echo Studio"), 0);
        assert!(!own.exists());
        assert!(other.exists());
        assert!(plain.exists());
    }

    #[test]
    fn status_serializes_for_the_frontend() {
        let status = Status {
            current: "0.5.1".into(),
            phase: Phase::Ready,
            available: Some(Available {
                version: "0.6.0".into(),
                notes: None,
            }),
            ..Status::default()
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"phase\":\"ready\""));
        assert!(json.contains("\"lastCheck\":null"));
    }
}
