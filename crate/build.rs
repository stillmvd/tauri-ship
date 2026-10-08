const COMMANDS: &[&str] = &["status", "check", "install"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
