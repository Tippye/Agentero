//! Hugging Face Daily Papers proxy. The upstream denies iframe embedding;
//! use the shared anonymous, fixed-origin transport and Plaza navigation bridge.

use super::SiteProxy;

const NAV_BRIDGE: &str = r##"<script>
(function () {
  var post = function (message) {
    message.source = "agentero-plaza";
    parent.postMessage(message, "*");
  };
  var send = function () {
    post({ path: location.pathname + location.search });
  };
  var resolve = function (href) {
    var url = new URL(href, "https://huggingface.co" + location.pathname + location.search);
    if (url.origin === "https://huggingface.co") {
      return new URL(url.pathname + url.search + url.hash, location.href);
    }
    return url;
  };
  var navigate = function (url) {
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== location.protocol) return;
    if (url.host === location.host && url.protocol === location.protocol) {
      location.assign(url.href);
    } else {
      post({ external: url.href });
    }
  };
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    var anchor = event.target.closest && event.target.closest("a[href]");
    if (!anchor) return;
    var href = anchor.getAttribute("href");
    if (!href || href.charAt(0) === "#") return;
    var url;
    try { url = resolve(href); } catch (_) { return; }
    event.preventDefault();
    event.stopPropagation();
    navigate(url);
  }, true);
  window.open = function (href) {
    if (href) {
      try { navigate(resolve(href)); } catch (_) {}
    }
    return null;
  };
  ["pushState", "replaceState"].forEach(function (kind) {
    var original = history[kind];
    history[kind] = function () {
      var result = original.apply(this, arguments);
      send();
      return result;
    };
  });
  window.addEventListener("popstate", send);
  send();
})();
</script>"##;

fn rewrite(html: &str) -> String {
    let html = crate::features::web::proxy::inject_selection_bridge(html);
    // Keep same-site resources under the fixed-origin proxy as well.
    let html = html
        .replace("https://huggingface.co/", "/")
        .replace("target=\"_blank\"", "target=\"_self\"")
        .replace("target='_blank'", "target='_self'");
    match html.find("</head>") {
        Some(index) => format!("{}{NAV_BRIDGE}{}", &html[..index], &html[index..]),
        None => format!("{NAV_BRIDGE}{html}"),
    }
}

static SITE: SiteProxy = SiteProxy {
    label: "Hugging Face Daily Papers",
    origin: "https://huggingface.co",
    user_agent: crate::core::http::USER_AGENT,
    rewrite,
};

pub fn handle(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    super::handle(&SITE, request, responder);
}

#[cfg(test)]
mod tests {
    use super::rewrite;

    #[test]
    fn keeps_papers_and_assets_local_but_preserves_external_links() {
        let html = r#"<html><head><link href="https://huggingface.co/front/style.css"></head><body><a href="https://huggingface.co/papers/2611.00001" target="_blank">Paper</a><a href="https://arxiv.org/abs/2611.00001">arXiv</a></body></html>"#;
        let out = rewrite(html);
        assert!(out.contains(r#"href="/front/style.css""#));
        assert!(out.contains(r#"href="/papers/2611.00001" target="_self""#));
        assert!(out.contains(r#"href="https://arxiv.org/abs/2611.00001""#));
        assert!(out.find("agentero-plaza").unwrap() < out.find("</head>").unwrap());
        assert!(out.contains("type: \"escape\""));
    }
}
