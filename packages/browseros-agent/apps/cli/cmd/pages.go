package cmd

import (
	"fmt"
	"strings"

	"browseros-cli/mcp"
	"browseros-cli/output"

	"github.com/spf13/cobra"
)

func init() {
	tabsCmd := &cobra.Command{
		Use:         "tabs",
		Aliases:     []string{"pages"},
		Annotations: map[string]string{"group": "Navigate:"},
		Short:       "List all open tabs",
		Args:        cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			c := newClient()
			toolResult, err := c.CallTool("tabs", tabsListToolArgs())
			if err != nil {
				output.Error(err.Error(), 1)
			}
			result := tabsListResult(toolResult)
			if jsonOut {
				output.JSON(result)
			} else {
				output.PageList(result)
			}
		},
	}

	activeCmd := &cobra.Command{
		Use:         "active",
		Annotations: map[string]string{"group": "Navigate:"},
		Short:       "Show the active (focused) page",
		Args:        cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			c := newClient()
			_, value, err := browserRunValue(c, `const pages = await browser.pages.list()
const page = pages.find((p) => p.isActive) ?? pages[0]
if (!page) throw new Error('No active page found.')
return page`)
			if err != nil {
				output.Error(err.Error(), 1)
			}
			page, ok := valueMap(value)
			if !ok {
				output.Error("active page response was not an object", 1)
			}
			result := activePageResult(page)
			if jsonOut {
				output.JSON(result)
			} else {
				output.ActivePage(result)
			}
		},
	}

	closeCmd := &cobra.Command{
		Use:         "close",
		Annotations: map[string]string{"group": "Navigate:"},
		Short:       "Close the page selected by -p/--page",
		Args:        cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			pageID, err := resolvePageID(nil)
			if err != nil {
				output.Error(err.Error(), 2)
			}
			c := newClient()
			result, err := c.CallTool("tabs", map[string]any{
				"action": "close",
				"page":   pageID,
			})
			if err != nil {
				output.Error(err.Error(), 1)
			}
			if jsonOut {
				output.JSON(result)
			} else {
				output.Confirm(result.TextContent())
			}
		},
	}

	rootCmd.AddCommand(tabsCmd, activeCmd, closeCmd)
}

func tabsListToolArgs() map[string]any {
	return map[string]any{"action": "list"}
}

// tabsListResult preserves the CLI's legacy pages/count shape around the MCP tabs tool.
func tabsListResult(result *mcp.ToolResult) *mcp.ToolResult {
	var pages []any
	if result != nil && result.StructuredContent != nil {
		pages = normalizeTabPages(valueSlice(result.StructuredContent["pages"]))
	}
	return textResult(formatPages(pages), map[string]any{
		"pages": pages,
		"count": len(pages),
	})
}

func activePageResult(page map[string]any) *mcp.ToolResult {
	normalized := normalizeTabPages([]any{page})
	if len(normalized) == 0 {
		return textResult("Active page: 0", map[string]any{"page": 0})
	}
	pageData, ok := normalized[0].(map[string]any)
	if !ok {
		return textResult("Active page: 0", map[string]any{"page": 0})
	}
	data := make(map[string]any, len(pageData))
	for key, value := range pageData {
		data[key] = value
	}
	return textResult(formatActivePage(data), data)
}

// normalizeTabPages exposes numeric page as the CLI's canonical tab handle.
func normalizeTabPages(pages []any) []any {
	normalized := make([]any, 0, len(pages))
	for _, item := range pages {
		page, ok := valueMap(item)
		if !ok {
			normalized = append(normalized, item)
			continue
		}
		copy := make(map[string]any, len(page)+1)
		for key, value := range page {
			if key == "pageId" {
				continue
			}
			copy[key] = value
		}
		if numberValue(copy["page"]) == 0 {
			if pageID := numberValue(page["pageId"]); pageID != 0 {
				copy["page"] = pageID
			}
		}
		normalized = append(normalized, copy)
	}
	return normalized
}

func formatPages(pages []any) string {
	if len(pages) == 0 {
		return "No pages open."
	}
	lines := make([]string, 0, len(pages))
	for _, item := range pages {
		page, ok := valueMap(item)
		if !ok {
			continue
		}
		pageID := numberValue(page["pageId"])
		if pageID == 0 {
			pageID = numberValue(page["page"])
		}
		tabID := numberValue(page["tabId"])
		title := stringValue(page["title"])
		url := stringValue(page["url"])
		if title == "" {
			title = "(untitled)"
		}
		active := ""
		if isActive, _ := page["isActive"].(bool); isActive {
			active = " [ACTIVE]"
		}
		if tabID == 0 {
			lines = append(lines, fmt.Sprintf("%d. %s%s\n   %s", pageID, title, active, url))
		} else {
			lines = append(lines, fmt.Sprintf("%d. %s (tab %d)%s\n   %s", pageID, title, tabID, active, url))
		}
	}
	return strings.Join(lines, "\n\n")
}

func formatActivePage(page map[string]any) string {
	pageID := numberValue(page["pageId"])
	if pageID == 0 {
		pageID = numberValue(page["page"])
	}
	tabID := numberValue(page["tabId"])
	title := stringValue(page["title"])
	url := stringValue(page["url"])
	if tabID == 0 {
		return fmt.Sprintf("Active page: %d\n%s\n%s", pageID, title, url)
	}
	return fmt.Sprintf("Active page: %d (tab %d)\n%s\n%s", pageID, tabID, title, url)
}
