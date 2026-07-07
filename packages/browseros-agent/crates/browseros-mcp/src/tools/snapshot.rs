use crate::{
    format::snapshot::format_snapshot_result,
    framework::{ToolCtx, ToolExecResult, ToolResult, parse_args, text_result},
};
use browseros_core::PageId;
use futures_util::future::BoxFuture;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

const DESCRIPTION: &str = "\
Capture the page as an indented accessibility tree. \
Each actionable element carries a stable [ref=eN] you pass to `act`. \
Iframe content is stitched in inline. \
Re-snapshot after navigation or large changes (refs are invalidated). \
This is the start of the loop: snapshot -> act -> (reads back a diff).";

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct SnapshotArgs {
    /// Page id from `tabs` or `navigate`.
    page: u32,
}

pub fn definition() -> crate::framework::ToolDef {
    super::def::<SnapshotArgs>(
        "snapshot",
        DESCRIPTION,
        Some(super::read_only_annotations()),
        handler,
    )
}

fn handler<'a>(
    raw: Value,
    ctx: &'a ToolCtx,
    _response: &'a mut crate::response::ToolResponse,
) -> BoxFuture<'a, ToolExecResult<Option<ToolResult>>> {
    Box::pin(async move {
        let args: SnapshotArgs = parse_args(raw)?;
        let snapshot = ctx
            .session
            .observe(PageId(args.page))
            .await
            .snapshot()
            .await?;
        let formatted = format_snapshot_result(&snapshot.text, &snapshot.url, ctx).await;
        let mut structured = formatted.structured;
        if let Value::Object(object) = &mut structured {
            object.insert("page".to_string(), json!(args.page));
        }
        Ok(Some(text_result(formatted.text, Some(structured))))
    })
}
