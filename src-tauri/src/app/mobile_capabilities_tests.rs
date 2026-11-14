//! Registration contract supplements the behavioral native-runner/private-Vault
//! tests. The mobile surface must not inherit desktop process capabilities.

#[test]
fn mobile_fs_scope_contract_excludes_host_private_data_and_ancestor_mutations() {
    use std::path::Path;
    use tauri::scope::fs::Pattern;

    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/mobile.json")).unwrap();
    let permissions = capability["permissions"].as_array().unwrap();
    for permission in [
        "fs:allow-read-file",
        "fs:allow-write-file",
        "fs:allow-rename",
        "fs:allow-remove",
    ] {
        assert!(permissions.iter().any(|value| value == permission));
    }
    let scope = permissions
        .iter()
        .find(|value| value["identifier"] == "fs:scope")
        .unwrap();
    let paths = |kind: &str| -> Vec<String> {
        scope[kind]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value["path"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(
        paths("allow"),
        [
            "$APPDATA/Vault",
            "$APPDATA/Vault/**",
            "$APPCACHE",
            "$APPCACHE/**",
        ]
    );
    assert_eq!(
        paths("deny"),
        [
            "$APPDATA/hosted-extractions",
            "$APPDATA/hosted-extractions/**",
        ]
    );
    // This is a JSON + public SDK glob-matcher contract, not an IPC/runtime
    // Scope test (Scope::new requires a Manager). Canonical fixtures and the
    // configured ** patterns have no single-star/separator ambiguity.
    let patterns = |kind: &str| -> Vec<Pattern> {
        paths(kind)
            .into_iter()
            .map(|path| {
                Pattern::new(
                    &path
                        .replace("$APPDATA", "/private/app/data")
                        .replace("$APPCACHE", "/private/app/cache"),
                )
                .unwrap()
            })
            .collect()
    };
    let allow = patterns("allow");
    let deny = patterns("deny");
    let matches = |patterns: &[Pattern], path: &str| {
        patterns
            .iter()
            .any(|pattern| pattern.matches_path(Path::new(path)))
    };
    let allowed = |path: &str| !matches(&deny, path) && matches(&allow, path);
    for path in [
        "/private/app/data/Vault",
        "/private/app/data/Vault/papers/a/source/paper.pdf",
        "/private/app/data/Vault/papers/a/marks/ink/p1.json",
        "/private/app/data/Vault/.agentero/import-tmp/one/0.pdf",
        "/private/app/cache",
        "/private/app/cache/pdf-reflow/paper/ir.json",
        "/private/app/cache/remote-region-drafts/region.png",
    ] {
        assert!(allowed(path), "required reader storage: {path}");
    }
    for path in [
        "/private/app/data",
        "/private/app",
        "/private/app/data/settings.json",
        "/private/app/data/ink/replica-id",
        "/private/app/data/hosted-extractions",
        "/private/app/data/hosted-extractions/id/receipt.json",
        "/private/app/data/hosted-extractions/id/result.bin",
        "/private/app/data/hosted-extractions/id.managed",
        "/private/app/data/Vault-other/paper.pdf",
    ] {
        // read/write/remove share fs:scope; rename resolves and checks BOTH
        // source and destination. Neither direction may move this data into
        // allowed Vault/cache, and recursive removal may not target its parent.
        assert!(!allowed(path), "Host-private path or ancestor: {path}");
    }
    assert!(matches(
        &deny,
        "/private/app/data/hosted-extractions/id/receipt.json"
    ));
}
#[test]
fn mobile_registers_scoped_api_processing_without_local_process_controls() {
    let source = include_str!("handlers.rs");
    let mobile = source
        .split("#[cfg(mobile)]")
        .last()
        .expect("mobile handler branch");
    for command in [
        "paper_import_native_pdfs",
        "paper_import_opened_pdf",
        "job_import_enqueue",
        "layout_remote_analyze_pdf",
        "layout_remote_probe",
        "job_layout_analyze_enqueue",
        "job_layout_translate_enqueue",
        "job_layout_translate_claim",
        "job_report",
        "job_focus_paper",
        "job_list",
        "job_cancel",
        "chat_import_extract",
        "paper_resolve_identifier",
        "paper_update_meta",
        "paper_set_tags",
        "paper_sync_publication",
        "paper_refs_parse",
        "paper_refs_list",
        "path_delete",
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
        "job_parse_body_enqueue",
        // Mobile delete is permanent; there is no recycle-bin UI to empty or
        // restore from, so the desktop trash commands stay unregistered.
        "path_trash",
        "path_list_trash",
        "path_restore_item",
        "path_purge_item",
        "path_purge_trash",
        "paper_layout_model_ensure",
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
