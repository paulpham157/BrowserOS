package serverbin

import (
	"path/filepath"
	"testing"
)

func TestMacOSSignSpecForShippedAgentCLIs(t *testing.T) {
	spec, ok := MacOSSignSpecFor("/x/codex")
	if !ok {
		t.Fatal("codex is not registered")
	}
	if spec.IdentifierSuffix != "codex" || spec.Options != "runtime" || spec.Entitlements != "" {
		t.Fatalf("codex spec = %#v", spec)
	}
	if _, ok := MacOSSignSpecFor("/x/claude"); ok {
		t.Fatal("claude should not be registered")
	}
}

func TestWindowsServerBinaries(t *testing.T) {
	wantCodex := false
	for _, rel := range WindowsServerBinaries {
		if rel == "third_party/codex.exe" {
			wantCodex = true
		}
		if rel == "third_party/claude.exe" {
			t.Fatal("claude should not be registered")
		}
	}
	if !wantCodex {
		t.Fatal("codex is not registered")
	}
}

func TestExpectedWindowsBinaryPaths(t *testing.T) {
	root := filepath.Join("tmp", "resources", "bin")
	paths := ExpectedWindowsBinaryPaths(root)
	if len(paths) != len(WindowsServerBinaries) {
		t.Fatalf("paths = %d, want %d", len(paths), len(WindowsServerBinaries))
	}
	for i, rel := range WindowsServerBinaries {
		if paths[i] != filepath.Join(root, filepath.FromSlash(rel)) {
			t.Fatalf("paths[%d] = %q, want %q", i, paths[i], filepath.Join(root, filepath.FromSlash(rel)))
		}
	}
}
