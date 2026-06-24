package cmd

import (
	"browseros-cli/output"

	"github.com/spf13/cobra"
)

func init() {
	cmd := &cobra.Command{
		Use:         "snapshot",
		Aliases:     []string{"snap"},
		Annotations: map[string]string{"group": "Observe:"},
		Short:       "Snapshot interactive elements on the page",
		Args:        cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			interactive, _ := cmd.Flags().GetBool("interactive")
			compact, _ := cmd.Flags().GetBool("compact")
			depth, _ := cmd.Flags().GetInt("depth")
			if err := validateChangedIntMinimum("--depth", depth, cmd.Flags().Changed("depth"), 0); err != nil {
				output.Error(err.Error(), 3)
			}
			filters := snapshotFilterOptions{interactive: interactive, compact: compact, depth: depth}

			pageID, err := resolvePageID(nil)
			if err != nil {
				output.Error(err.Error(), 2)
			}
			c := newClient()

			result, err := c.CallTool("snapshot", map[string]any{"page": pageID})
			if err != nil {
				output.Error(err.Error(), 1)
			}
			result = snapshotOutputResult(result, pageID, filters, jsonOut)
			if jsonOut {
				output.JSON(result)
			} else {
				output.Text(result)
			}
		},
	}

	cmd.Flags().BoolP("interactive", "i", false, "Show actionable rows")
	cmd.Flags().BoolP("compact", "c", false, "Hide empty structural rows")
	cmd.Flags().IntP("depth", "d", 0, "Maximum indentation depth")

	rootCmd.AddCommand(cmd)
}
