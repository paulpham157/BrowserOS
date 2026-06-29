diff --git a/chrome/browser/browseros/server/browseros_server_config_unittest.cc b/chrome/browser/browseros/server/browseros_server_config_unittest.cc
new file mode 100644
index 0000000000000..f308d27b3bca1
--- /dev/null
+++ b/chrome/browser/browseros/server/browseros_server_config_unittest.cc
@@ -0,0 +1,142 @@
+// Copyright 2024 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#include "chrome/browser/browseros/server/browseros_server_config.h"
+
+#include <string_view>
+
+#include "testing/gtest/include/gtest/gtest.h"
+
+namespace browseros {
+namespace {
+
+base::FilePath::StringType ToPathString(
+    base::FilePath::StringViewType value) {
+  return base::FilePath::StringType(value.begin(), value.end());
+}
+
+ServerLaunchConfig BuildLaunchConfig(ServerConfigKind kind) {
+  ServerLaunchConfig config;
+  config.config_kind = kind;
+  config.config_file_name = FILE_PATH_LITERAL("config.json");
+  config.health_path = "/health";
+  config.log_name = "test server";
+  config.enable_updater = kind == ServerConfigKind::kBrowserOS;
+
+  config.ports.cdp = 9222;
+  config.ports.server = 9230;
+  config.ports.extension = 9240;
+  config.ports.proxy = 9250;
+
+  config.paths.exe = base::FilePath(FILE_PATH_LITERAL("server"));
+  config.paths.execution = base::FilePath(FILE_PATH_LITERAL("execution"));
+
+  config.identity.install_id = "install-id";
+  config.identity.browseros_version = "1.2.3";
+  config.identity.chromium_version = "140.0.0.0";
+  config.allow_remote_in_mcp = true;
+
+  return config;
+}
+
+TEST(BrowserOSServerConfigTest, BrowserOSDescriptorMatchesLegacyServer) {
+  const ManagedServerDescriptor& descriptor = GetBrowserOSServerDescriptor();
+
+  EXPECT_EQ(Product::kBrowserOS, descriptor.product);
+  EXPECT_EQ(std::string_view("BrowserOS server"), descriptor.log_name);
+  EXPECT_EQ(base::FilePath::StringType(FILE_PATH_LITERAL("BrowserOSServer")),
+            ToPathString(descriptor.bundle_dir));
+  EXPECT_EQ(base::FilePath::StringType(FILE_PATH_LITERAL("browseros_server")),
+            ToPathString(descriptor.binary_name));
+  EXPECT_EQ(base::FilePath::StringType(FILE_PATH_LITERAL("server_config.json")),
+            ToPathString(descriptor.config_file_name));
+  EXPECT_EQ(std::string_view("/health"), descriptor.health_path);
+  EXPECT_EQ(ServerConfigKind::kBrowserOS, descriptor.config_kind);
+  EXPECT_TRUE(descriptor.enable_updater);
+}
+
+TEST(BrowserOSServerConfigTest, BrowserClawDescriptorDisablesUpdater) {
+  const ManagedServerDescriptor& descriptor = GetBrowserClawServerDescriptor();
+
+  EXPECT_EQ(Product::kBrowserClaw, descriptor.product);
+  EXPECT_EQ(std::string_view("BrowserClaw server"), descriptor.log_name);
+  EXPECT_EQ(base::FilePath::StringType(FILE_PATH_LITERAL("BrowserClawServer")),
+            ToPathString(descriptor.bundle_dir));
+  EXPECT_EQ(
+      base::FilePath::StringType(FILE_PATH_LITERAL("browseros-claw-server")),
+      ToPathString(descriptor.binary_name));
+  EXPECT_EQ(base::FilePath::StringType(FILE_PATH_LITERAL("claw_config.json")),
+            ToPathString(descriptor.config_file_name));
+  EXPECT_EQ(std::string_view("/system/health"), descriptor.health_path);
+  EXPECT_EQ(ServerConfigKind::kBrowserClaw, descriptor.config_kind);
+  EXPECT_FALSE(descriptor.enable_updater);
+}
+
+TEST(BrowserOSServerConfigTest, BrowserOSConfigKeepsLegacyShape) {
+  ServerLaunchConfig config = BuildLaunchConfig(ServerConfigKind::kBrowserOS);
+  base::FilePath resources(FILE_PATH_LITERAL("resources"));
+
+  base::DictValue root = BuildServerConfigJson(config, resources);
+
+  const base::DictValue* ports = root.FindDict("ports");
+  ASSERT_NE(nullptr, ports);
+  ASSERT_TRUE(ports->FindInt("cdp").has_value());
+  EXPECT_EQ(9222, ports->FindInt("cdp").value());
+  ASSERT_TRUE(ports->FindInt("server").has_value());
+  EXPECT_EQ(9230, ports->FindInt("server").value());
+  ASSERT_TRUE(ports->FindInt("extension").has_value());
+  EXPECT_EQ(9240, ports->FindInt("extension").value());
+  ASSERT_TRUE(ports->FindInt("proxy").has_value());
+  EXPECT_EQ(9250, ports->FindInt("proxy").value());
+
+  const base::DictValue* directories = root.FindDict("directories");
+  ASSERT_NE(nullptr, directories);
+  ASSERT_NE(nullptr, directories->FindString("resources"));
+  EXPECT_EQ(resources.AsUTF8Unsafe(), *directories->FindString("resources"));
+  ASSERT_NE(nullptr, directories->FindString("execution"));
+  EXPECT_EQ(config.paths.execution.AsUTF8Unsafe(),
+            *directories->FindString("execution"));
+
+  const base::DictValue* flags = root.FindDict("flags");
+  ASSERT_NE(nullptr, flags);
+  ASSERT_TRUE(flags->FindBool("allow_remote_in_mcp").has_value());
+  EXPECT_TRUE(flags->FindBool("allow_remote_in_mcp").value());
+
+  const base::DictValue* instance = root.FindDict("instance");
+  ASSERT_NE(nullptr, instance);
+  ASSERT_NE(nullptr, instance->FindString("install_id"));
+  EXPECT_EQ("install-id", *instance->FindString("install_id"));
+  ASSERT_NE(nullptr, instance->FindString("browseros_version"));
+  EXPECT_EQ("1.2.3", *instance->FindString("browseros_version"));
+  ASSERT_NE(nullptr, instance->FindString("chromium_version"));
+  EXPECT_EQ("140.0.0.0", *instance->FindString("chromium_version"));
+}
+
+TEST(BrowserOSServerConfigTest, BrowserClawConfigUsesStrictShape) {
+  ServerLaunchConfig config = BuildLaunchConfig(ServerConfigKind::kBrowserClaw);
+  base::FilePath resources(FILE_PATH_LITERAL("resources"));
+
+  base::DictValue root = BuildServerConfigJson(config, resources);
+
+  const base::DictValue* ports = root.FindDict("ports");
+  ASSERT_NE(nullptr, ports);
+  ASSERT_TRUE(ports->FindInt("server").has_value());
+  EXPECT_EQ(9230, ports->FindInt("server").value());
+  ASSERT_TRUE(ports->FindInt("cdp").has_value());
+  EXPECT_EQ(9222, ports->FindInt("cdp").value());
+  EXPECT_FALSE(ports->FindInt("extension").has_value());
+  EXPECT_FALSE(ports->FindInt("proxy").has_value());
+
+  const base::DictValue* directories = root.FindDict("directories");
+  ASSERT_NE(nullptr, directories);
+  ASSERT_NE(nullptr, directories->FindString("resources"));
+  EXPECT_EQ(resources.AsUTF8Unsafe(), *directories->FindString("resources"));
+  EXPECT_EQ(nullptr, directories->FindString("execution"));
+
+  EXPECT_EQ(nullptr, root.FindDict("flags"));
+  EXPECT_EQ(nullptr, root.FindDict("instance"));
+}
+
+}  // namespace
+}  // namespace browseros
