#!/usr/bin/env python3
"""Tests for per-product user-data identity stamping against a mock checkout."""

import tempfile
import unittest
from pathlib import Path

from .product_identity import (
    INSTALL_MODES_FILE,
    PATHS_LINUX_FILE,
    PLIST_FILE,
    ProductIdentityModule,
    stamp_product_identity,
)
from ...core.step import ValidationError
from ...lib.testing import MockBrowserOSRoot, MockChromium, make_context

# Seeds mirror the three files AFTER the chromium patches have applied —
# i.e. carrying the BrowserOS (default product) values.
_PLIST_PATCHED = """\
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>${PRODUCT_STRING}</string>
\t<key>SUAutomaticallyUpdate</key>
\t<true/>
\t<key>CrProductDirName</key>
\t<string>BrowserOS</string>
</dict>
</plist>
"""

_PATHS_LINUX_PATCHED = """\
bool GetDefaultUserDataDirectory(base::FilePath* result) {
#if BUILDFLAG(GOOGLE_CHROME_FOR_TESTING_BRANDING)
  std::string data_dir_basename = "google-chrome-for-testing";
#elif BUILDFLAG(GOOGLE_CHROME_BRANDING)
  std::string data_dir_basename = "google-chrome";
#else
  std::string data_dir_basename = "browser-os";
#endif
  *result = config_dir.Append(data_dir_basename + GetChannelSuffixForDataDir());
  return true;
}
"""

_INSTALL_MODES_PATCHED = """\
inline constexpr wchar_t kCompanyPathName[] = L"";

// The brand-specific product name to be included as a component of the install
// and user data directory paths.
inline constexpr wchar_t kProductPathName[] = L"BrowserOS";

inline constexpr char kSafeBrowsingName[] = "chromium";
"""


class StampProductIdentityTest(unittest.TestCase):
    def setUp(self):
        self._chromium_tmp = tempfile.TemporaryDirectory()
        self._root_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._chromium_tmp.cleanup)
        self.addCleanup(self._root_tmp.cleanup)
        self.chromium = MockChromium(Path(self._chromium_tmp.name))
        self.root = MockBrowserOSRoot(Path(self._root_tmp.name))

    def _seed_patched_tree(self):
        self.chromium.add_file(PLIST_FILE, _PLIST_PATCHED)
        self.chromium.add_file(PATHS_LINUX_FILE, _PATHS_LINUX_PATCHED)
        self.chromium.add_file(INSTALL_MODES_FILE, _INSTALL_MODES_PATCHED)

    def _read(self, relative_path: str) -> str:
        return (self.chromium.src / relative_path).read_text()

    def test_browserclaw_stamps_all_three_files(self):
        self._seed_patched_tree()
        ctx = make_context(self.chromium, self.root, product="browserclaw")

        stamp_product_identity(ctx)

        plist = self._read(PLIST_FILE)
        self.assertIn("<key>CrProductDirName</key>\n\t<string>BrowserClaw</string>", plist)
        self.assertNotIn("<string>BrowserOS</string>", plist)

        paths_linux = self._read(PATHS_LINUX_FILE)
        self.assertIn('data_dir_basename = "browser-claw";', paths_linux)
        self.assertNotIn('"browser-os"', paths_linux)

        install_modes = self._read(INSTALL_MODES_FILE)
        self.assertIn('kProductPathName[] = L"BrowserClaw";', install_modes)

    def test_browserclaw_leaves_other_branding_branches_alone(self):
        self._seed_patched_tree()
        ctx = make_context(self.chromium, self.root, product="browserclaw")

        stamp_product_identity(ctx)

        paths_linux = self._read(PATHS_LINUX_FILE)
        self.assertIn('data_dir_basename = "google-chrome";', paths_linux)
        self.assertIn('data_dir_basename = "google-chrome-for-testing";', paths_linux)
        self.assertIn("${PRODUCT_STRING}", self._read(PLIST_FILE))
        self.assertIn('kSafeBrowsingName[] = "chromium";', self._read(INSTALL_MODES_FILE))

    def test_browseros_is_a_byte_level_noop(self):
        self._seed_patched_tree()
        ctx = make_context(self.chromium, self.root, product="browseros")
        stats_before = {
            path: (self.chromium.src / path).stat().st_mtime_ns
            for path in (PLIST_FILE, PATHS_LINUX_FILE, INSTALL_MODES_FILE)
        }

        stamp_product_identity(ctx)

        self.assertEqual(self._read(PLIST_FILE), _PLIST_PATCHED)
        self.assertEqual(self._read(PATHS_LINUX_FILE), _PATHS_LINUX_PATCHED)
        self.assertEqual(self._read(INSTALL_MODES_FILE), _INSTALL_MODES_PATCHED)
        for path, mtime_before in stats_before.items():
            self.assertEqual(
                (self.chromium.src / path).stat().st_mtime_ns,
                mtime_before,
                f"unchanged file was rewritten: {path}",
            )

    def test_stamping_twice_is_idempotent(self):
        self._seed_patched_tree()
        ctx = make_context(self.chromium, self.root, product="browserclaw")

        stamp_product_identity(ctx)
        first_pass = {
            path: self._read(path)
            for path in (PLIST_FILE, PATHS_LINUX_FILE, INSTALL_MODES_FILE)
        }

        stamp_product_identity(ctx)
        for path, content in first_pass.items():
            self.assertEqual(self._read(path), content)

    def test_missing_file_raises_with_path(self):
        self.chromium.add_file(PLIST_FILE, _PLIST_PATCHED)
        self.chromium.add_file(PATHS_LINUX_FILE, _PATHS_LINUX_PATCHED)
        ctx = make_context(self.chromium, self.root, product="browserclaw")

        with self.assertRaisesRegex(RuntimeError, INSTALL_MODES_FILE):
            stamp_product_identity(ctx)

    def test_missing_anchor_raises_with_path(self):
        self._seed_patched_tree()
        self.chromium.add_file(
            PLIST_FILE, _PLIST_PATCHED.replace("CrProductDirName", "CrSomethingElse")
        )
        ctx = make_context(self.chromium, self.root, product="browserclaw")

        with self.assertRaisesRegex(RuntimeError, PLIST_FILE):
            stamp_product_identity(ctx)

    def test_duplicate_anchor_raises(self):
        self._seed_patched_tree()
        duplicated = (
            "\t<key>CrProductDirName</key>\n\t<string>BrowserOS</string>\n"
        )
        self.chromium.add_file(
            PLIST_FILE, _PLIST_PATCHED.replace(duplicated, duplicated * 2)
        )
        ctx = make_context(self.chromium, self.root, product="browserclaw")

        with self.assertRaisesRegex(RuntimeError, "2"):
            stamp_product_identity(ctx)


class ProductIdentityModuleTest(unittest.TestCase):
    def test_validate_requires_chromium_src(self):
        with tempfile.TemporaryDirectory() as chromium_tmp, \
                tempfile.TemporaryDirectory() as root_tmp:
            chromium = MockChromium(Path(chromium_tmp))
            root = MockBrowserOSRoot(Path(root_tmp))
            ctx = make_context(chromium, root)
            ctx.chromium_src = Path(chromium_tmp) / "nope"

            with self.assertRaises(ValidationError):
                ProductIdentityModule().validate(ctx)


if __name__ == "__main__":
    unittest.main()
