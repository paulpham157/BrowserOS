diff --git a/chrome/browser/browseros/server/browseros_server_config.h b/chrome/browser/browseros/server/browseros_server_config.h
new file mode 100644
index 0000000000000..f41e7536e90a5
--- /dev/null
+++ b/chrome/browser/browseros/server/browseros_server_config.h
@@ -0,0 +1,135 @@
+// Copyright 2024 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#ifndef CHROME_BROWSER_BROWSEROS_SERVER_BROWSEROS_SERVER_CONFIG_H_
+#define CHROME_BROWSER_BROWSEROS_SERVER_BROWSEROS_SERVER_CONFIG_H_
+
+#include <string>
+#include <string_view>
+
+#include "base/files/file_path.h"
+#include "base/values.h"
+#include "chrome/browser/browseros/core/browseros_product.h"
+
+namespace browseros {
+
+struct ServerLaunchConfig;
+
+enum class ServerConfigKind {
+  kBrowserOS,
+  kBrowserClaw,
+};
+
+struct ManagedServerDescriptor {
+  Product product;
+  std::string_view log_name;
+  base::FilePath::StringViewType bundle_dir;
+  base::FilePath::StringViewType binary_name;
+  base::FilePath::StringViewType config_file_name;
+  std::string_view health_path;
+  ServerConfigKind config_kind;
+  bool enable_updater;
+};
+
+const ManagedServerDescriptor& GetBrowserOSServerDescriptor();
+const ManagedServerDescriptor& GetBrowserClawServerDescriptor();
+
+// Returns the server descriptor selected by the build-time product identity.
+const ManagedServerDescriptor& GetManagedServerDescriptor();
+
+// Builds the JSON config expected by the selected server product.
+base::DictValue BuildServerConfigJson(
+    const ServerLaunchConfig& config,
+    const base::FilePath& actual_resources_dir);
+
+// Port assignments for all server endpoints.
+// This is the single source of truth for port configuration.
+struct ServerPorts {
+  int cdp = 0;
+  int server = 0;  // ephemeral backend port for sidecar (was "mcp")
+  int extension = 0;
+  int proxy = 0;  // stable MCP proxy port bound by Chromium
+
+  bool operator==(const ServerPorts&) const = default;
+
+  // Returns true if all ports are assigned (non-zero).
+  bool IsValid() const;
+
+  // Returns a debug string for logging.
+  std::string DebugString() const;
+};
+
+// Filesystem paths needed to launch the server.
+// Computed fresh before each launch since the updater can change paths.
+struct ServerPaths {
+  ServerPaths();
+  ServerPaths(const ServerPaths&);
+  ServerPaths& operator=(const ServerPaths&);
+  ServerPaths(ServerPaths&&);
+  ServerPaths& operator=(ServerPaths&&);
+  ~ServerPaths();
+
+  // Primary binary path (may be OTA-updated version).
+  base::FilePath exe;
+
+  // Bundled binary path (always available as fallback).
+  base::FilePath fallback_exe;
+
+  // Primary resources directory.
+  base::FilePath resources;
+
+  // Bundled resources directory (fallback).
+  base::FilePath fallback_resources;
+
+  // Runtime data directory (~/.browseros or equivalent).
+  base::FilePath execution;
+
+  // Returns true if required paths are set.
+  bool IsValid() const;
+
+  // Returns a debug string for logging.
+  std::string DebugString() const;
+};
+
+// Identity and versioning info written to the server config JSON.
+struct ServerIdentity {
+  std::string install_id;
+  std::string browseros_version;
+  std::string chromium_version;
+
+  // Returns a debug string for logging.
+  std::string DebugString() const;
+};
+
+// Complete configuration for a single server launch.
+// Assembled fresh before each ProcessController::Launch() call.
+struct ServerLaunchConfig {
+  ServerLaunchConfig();
+  ServerLaunchConfig(const ServerLaunchConfig&);
+  ServerLaunchConfig& operator=(const ServerLaunchConfig&);
+  ServerLaunchConfig(ServerLaunchConfig&&);
+  ServerLaunchConfig& operator=(ServerLaunchConfig&&);
+  ~ServerLaunchConfig();
+
+  std::string log_name;
+  base::FilePath::StringType config_file_name;
+  std::string health_path;
+  ServerConfigKind config_kind = ServerConfigKind::kBrowserOS;
+  bool enable_updater = true;
+
+  ServerPorts ports;
+  ServerPaths paths;
+  ServerIdentity identity;
+  bool allow_remote_in_mcp = false;
+
+  // Returns true if the config is valid for launching.
+  bool IsValid() const;
+
+  // Returns a debug string for logging.
+  std::string DebugString() const;
+};
+
+}  // namespace browseros
+
+#endif  // CHROME_BROWSER_BROWSEROS_SERVER_BROWSEROS_SERVER_CONFIG_H_
