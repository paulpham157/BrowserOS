#!/usr/bin/env python3
"""Per-product user-data directory identity stamping.

The chromium patches are product-neutral: they carry the BrowserOS
(default product) profile-directory values. This step runs right after
`patches` and rewrites those values for the active product, so each
product gets its own user-data root (and thus its own SingletonLock —
the two browsers can run side by side). For browseros the stamp is a
byte-level no-op, keeping default trees identical to the patch stack.
"""

import re
from typing import Tuple

from ...core.context import Context
from ...core.products import ProductDescriptor
from ...core.step import Step, ValidationError, step
from ...lib.utils import log_info, log_success

# macOS profile root: CrProductDirName read from the outer app bundle's
# Info.plist (chrome/common/chrome_paths_mac.mm).
PLIST_FILE = "chrome/app/app-Info.plist"
# Linux profile root: data_dir_basename under ~/.config.
PATHS_LINUX_FILE = "chrome/common/chrome_paths_linux.cc"
# Windows user-data root: kProductPathName under %LOCALAPPDATA%.
INSTALL_MODES_FILE = "chrome/install_static/chromium_install_modes.h"

# Anchors are structural (key/variable names, never the current value),
# so stamping is idempotent and re-runs are safe.
_PLIST_ANCHOR = re.compile(r"(<key>CrProductDirName</key>\s*<string>)[^<]*(</string>)")
_PATHS_LINUX_ANCHOR = re.compile(
    r'(#else\s*\n\s*std::string data_dir_basename = ")[^"]*(";)'
)
_INSTALL_MODES_ANCHOR = re.compile(
    r'(inline constexpr wchar_t kProductPathName\[\] = L")[^"]*(";)'
)


@step("product_identity", phase="prep")
class ProductIdentityModule(Step):
    produces = []
    requires = []
    description = "Stamp per-product user-data directory identity into patched files"

    def validate(self, ctx: Context) -> None:
        if not ctx.chromium_src.exists():
            raise ValidationError(f"Chromium source not found: {ctx.chromium_src}")

    def execute(self, ctx: Context) -> None:
        stamp_product_identity(ctx)


def _identity_stamps(
    product: ProductDescriptor,
) -> Tuple[Tuple[str, re.Pattern, str], ...]:
    return (
        (PLIST_FILE, _PLIST_ANCHOR, product.mac.product_dir_name),
        (PATHS_LINUX_FILE, _PATHS_LINUX_ANCHOR, product.linux.user_data_dir_name),
        (INSTALL_MODES_FILE, _INSTALL_MODES_ANCHOR, product.windows.product_path_name),
    )


def stamp_product_identity(ctx: Context) -> None:
    """Rewrite the patched user-data identity values for ctx.product.

    Each anchor must match exactly once; anything else means the patch
    stack drifted and shipping would silently share a profile root, so
    the build dies here instead.
    """
    log_info(f"\n🪪 Stamping user-data identity for product '{ctx.product.id}'...")

    for relative_path, anchor, value in _identity_stamps(ctx.product):
        path = ctx.chromium_src / relative_path
        if not path.exists():
            raise RuntimeError(
                f"product_identity: {relative_path} not found in chromium_src "
                "(patches not applied?)"
            )

        content = path.read_text(encoding="utf-8")
        matches = anchor.findall(content)
        if len(matches) != 1:
            raise RuntimeError(
                f"product_identity: expected exactly 1 anchor in {relative_path}, "
                f"found {len(matches)} — patch drift?"
            )

        stamped = anchor.sub(lambda m: f"{m.group(1)}{value}{m.group(2)}", content)
        if stamped == content:
            log_info(f"  • {relative_path}: already '{value}'")
            continue
        path.write_text(stamped, encoding="utf-8")
        log_info(f"  • {relative_path}: → '{value}'")

    log_success("User-data identity stamped")
