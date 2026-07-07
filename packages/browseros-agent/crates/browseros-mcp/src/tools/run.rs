use crate::framework::{ToolCtx, ToolExecResult, ToolResult, parse_args, text_result};
use futures_util::future::BoxFuture;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

const DEFAULT_TIMEOUT_MS: f64 = 30_000.0;

const DESCRIPTION: &str = r#"Run JavaScript against the `browser` SDK in the server runtime for multi-step flows and data extraction that would otherwise take many tool calls. `console.log` is captured; `return` a value to read it back; exceptions come back as a result, not a thrown error.

Available as `browser`:
  browser.pages.list() / newPage(url) / close(pageId) / getInfo(pageId)
  browser.observe(pageId).snapshot()  -> { text, refs }
  browser.observe(pageId).diff()      -> { text, added, removed, changed }
  browser.observe(pageId).resolveRef(ref)
  browser.input(pageId).click(ref) / fill(ref,value) / type(text) / press(key) / hover(ref) / selectOption(ref,value) / scroll(dir,amount,ref?)
  browser.nav(pageId).goto(url) / back() / forward() / reload()
  browser.cdp(method, params?, sessionId?)   // raw CDP escape hatch
  browser.cdpJsonForPage(pageId, method, paramsJson) // page-scoped raw CDP with validated JSON params
Refs (eN) come from a snapshot's text/refs."#;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct RunArgs {
    /// Async-capable JS body. Use top-level await; `return` a value.
    code: String,
    /// Max run time in ms (default 30000).
    #[serde(default = "default_timeout")]
    timeout: f64,
}

#[derive(Debug, Clone, serde::Serialize, JsonSchema)]
struct RunOutput {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    logs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub fn definition() -> crate::framework::ToolDef {
    super::def_with_output::<RunArgs, RunOutput>(
        "run",
        DESCRIPTION,
        Some(super::open_world_annotations()),
        handler,
    )
}

fn handler<'a>(
    raw: Value,
    _ctx: &'a ToolCtx,
    _response: &'a mut crate::response::ToolResponse,
) -> BoxFuture<'a, ToolExecResult<Option<ToolResult>>> {
    Box::pin(async move {
        let args: RunArgs = parse_args(raw)?;
        let _ = (args.code, args.timeout);
        let error = "run is not yet supported in the Rust server";
        let mut result = text_result(
            error,
            Some(json!({ "ok": false, "logs": [], "error": error })),
        );
        result.is_error = true;
        Ok(Some(result))
    })
}

fn default_timeout() -> f64 {
    DEFAULT_TIMEOUT_MS
}
