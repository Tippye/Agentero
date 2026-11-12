//! Registration contract supplements the behavioral native-runner/private-Vault
//! tests. The mobile surface must not inherit desktop process capabilities.
#[test]
fn mobile_registers_native_import_and_plaza_without_renderer_or_local_process_controls() {
    let source = include_str!("handlers.rs");
    let mobile = source
        .split("#[cfg(mobile)]")
        .last()
        .expect("mobile handler branch");
    for command in [
        "job_import_enqueue",
        "job_list",
        "job_cancel",
        "chat_import_extract",
        "paper_resolve_identifier",
        "paper_update_meta",
        "paper_set_tags",
        "paper_sync_publication",
        "easy_scholar_probe",
        "feeds_list",
        "feeds_add",
        "feeds_refresh",
        "feeds_items",
        "recommend_arxiv",
        "recommend_arxiv_last",
        "probe_embedding",
        "mobile_stylus_get_state",
        "mobile_stylus_set_target",
    ] {
        assert!(
            mobile.contains(&format!("::{command},")),
            "missing mobile command {command}"
        );
    }
    for prefix in [
        "crate::features::agent::",
        "crate::features::compile::",
        "crate::features::writing::",
        "crate::features::rtex::",
        "crate::integration::word::",
        "crate::integration::remote::",
        "crate::integration::plugins::",
    ] {
        assert!(
            !mobile.contains(prefix),
            "mobile must not register {prefix}"
        );
    }
    for command in [
        "job_report",
        "job_layout_translate_claim",
        "job_latex_compile_enqueue",
        "skill_install",
        "skill_discard",
        "lookup_import_batch",
        "bridge_start",
    ] {
        assert!(
            !mobile.contains(&format!("::{command},")),
            "mobile must not register {command}"
        );
    }
}
