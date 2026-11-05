#!/usr/bin/env ruby
# Kaynak dosyaları ve test hedefini App.xcodeproj'a ekler; yinelenen çalıştırma etkisizdir. Görev 8 ve 10 hedefleri de buraya eklenir.
require 'xcodeproj'

root = File.expand_path('../ios/App', __dir__)
project = Xcodeproj::Project.open(File.join(root, 'App.xcodeproj'))
app = project.targets.find { |t| t.name == 'App' }

def add_sources(project, target, group, names)
  names.each do |name|
    ref = group.files.find { |f| f.path == name } || group.new_reference(name)
    target.add_file_references([ref]) unless target.source_build_phase.files_references.include?(ref)
  end
end

app_group = project.main_group['App']
add_sources(project, app, app_group, %w[
  AppServices.swift AppViewController.swift AttachmentPreview.swift BridgeGate.swift GeckoNativePlugin.swift IncomingLinks.swift LockGate.swift PushCenter.swift
  SessionApi.swift SessionStore.swift
])
ent = app_group.files.find { |f| f.path == 'App.entitlements' } || app_group.new_reference('App.entitlements')
app.build_configurations.each { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements' }

# GeckoPushCore yerel paketi
pkg = project.root_object.package_references.find { |r| r.respond_to?(:relative_path) && r.relative_path == '../GeckoPushCore' }
unless pkg
  pkg = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
  pkg.relative_path = '../GeckoPushCore'
  project.root_object.package_references << pkg
end
link_core = lambda do |target|
  next if target.package_product_dependencies.any? { |d| d.product_name == 'GeckoPushCore' }
  dep = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  dep.product_name = 'GeckoPushCore'
  target.package_product_dependencies << dep
  file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
  file.product_ref = dep
  target.frameworks_build_phase.files << file
end
link_core.call(app)

# Notification Service Extension
nse = project.targets.find { |t| t.name == 'NotificationService' }
unless nse
  nse = project.new_target(:app_extension, 'NotificationService', :ios, '15.0')
  app.add_dependency(nse)
  embed = app.new_copy_files_build_phase('Embed Foundation Extensions')
  embed.symbol_dst_subfolder_spec = :plug_ins
  embed.add_file_reference(nse.product_reference).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end
nse.build_configurations.each do |c|
  c.build_settings.merge!(
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.kodviva.geckomail.NotificationService',
    'INFOPLIST_FILE' => '../NotificationService/Info.plist',
    'CODE_SIGN_ENTITLEMENTS' => '../NotificationService/NotificationService.entitlements',
    'SWIFT_VERSION' => '5.0',
    'IPHONEOS_DEPLOYMENT_TARGET' => '15.0',
    'MARKETING_VERSION' => '1.0',
    'CURRENT_PROJECT_VERSION' => '1',
    'SKIP_INSTALL' => 'YES',
    'TARGETED_DEVICE_FAMILY' => '1,2'
  )
end
link_core.call(nse)
nse_group = project.main_group['NotificationService'] || project.main_group.new_group('NotificationService', '../NotificationService')
add_sources(project, nse, nse_group, %w[NotificationService.swift])
privacy = nse_group.files.find { |f| f.path == 'PrivacyInfo.xcprivacy' } || nse_group.new_reference('PrivacyInfo.xcprivacy')
nse.add_resources([privacy]) unless nse.resources_build_phase.files_references.include?(privacy)
localized = nse_group.children.find { |c| c.display_name == 'Localizable.strings' } || nse_group.new_variant_group('Localizable.strings')
Dir.glob(File.join(root, '../NotificationService/*.lproj')).sort.each do |dir|
  lang = File.basename(dir, '.lproj')
  rel = "#{lang}.lproj/Localizable.strings"
  next if localized.files.any? { |f| f.path == rel }
  f = localized.new_reference(rel)
  f.name = lang
end
nse.add_resources([localized]) unless nse.resources_build_phase.files_references.include?(localized)

# Paylaş eklentisi: dosyaları App Group kapsayıcısına yazar, uygulama etkinleşince görür
share = project.targets.find { |t| t.name == 'ShareExtension' }
unless share
  share = project.new_target(:app_extension, 'ShareExtension', :ios, '15.0')
  app.add_dependency(share)
  embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' }
  embed.add_file_reference(share.product_reference).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end
share.build_configurations.each do |c|
  c.build_settings.merge!(
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.kodviva.geckomail.Share',
    'INFOPLIST_FILE' => '../ShareExtension/Info.plist',
    'CODE_SIGN_ENTITLEMENTS' => '../ShareExtension/ShareExtension.entitlements',
    'SWIFT_VERSION' => '5.0',
    'IPHONEOS_DEPLOYMENT_TARGET' => '15.0',
    'MARKETING_VERSION' => '1.0',
    'CURRENT_PROJECT_VERSION' => '1',
    'SKIP_INSTALL' => 'YES',
    'TARGETED_DEVICE_FAMILY' => '1,2'
  )
end
link_core.call(share)
share_group = project.main_group['ShareExtension'] || project.main_group.new_group('ShareExtension', '../ShareExtension')
add_sources(project, share, share_group, %w[ShareViewController.swift])
share_privacy = share_group.files.find { |f| f.path == 'PrivacyInfo.xcprivacy' } || share_group.new_reference('PrivacyInfo.xcprivacy')
share.add_resources([share_privacy]) unless share.resources_build_phase.files_references.include?(share_privacy)
share_strings = share_group.children.find { |c| c.display_name == 'Localizable.strings' } || share_group.new_variant_group('Localizable.strings')
Dir.glob(File.join(root, '../ShareExtension/*.lproj')).sort.each do |dir|
  lang = File.basename(dir, '.lproj')
  rel = "#{lang}.lproj/Localizable.strings"
  next if share_strings.files.any? { |f| f.path == rel }
  f = share_strings.new_reference(rel)
  f.name = lang
end
share.add_resources([share_strings]) unless share.resources_build_phase.files_references.include?(share_strings)

app_group = project.main_group['App']
app_privacy = app_group.files.find { |f| f.path == 'PrivacyInfo.xcprivacy' } || app_group.new_reference('PrivacyInfo.xcprivacy')
app.add_resources([app_privacy]) unless app.resources_build_phase.files_references.include?(app_privacy)

tests = project.targets.find { |t| t.name == 'AppTests' }
unless tests
  tests = project.new_target(:unit_test_bundle, 'AppTests', :ios, '15.0')
  tests.add_dependency(app)
end
tests.build_configurations.each do |c|
  c.build_settings.merge!(
    'BUNDLE_LOADER' => '$(TEST_HOST)',
    'TEST_HOST' => '$(BUILT_PRODUCTS_DIR)/App.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/App',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'SWIFT_VERSION' => '5.0',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.kodviva.geckomail.tests',
    'IPHONEOS_DEPLOYMENT_TARGET' => '15.0'
  )
end
test_group = project.main_group['AppTests'] || project.main_group.new_group('AppTests', 'AppTests')
add_sources(project, tests, test_group, Dir.children(File.join(root, 'AppTests')).grep(/\.swift$/).sort)
link_core.call(tests)
add_sources(project, tests, nse_group, %w[NotificationService.swift]) # didReceive XCTest'te doğrudan çağrılır

# Uçtan uca: yığın gerektirir, App şemasına girmez (yalnız kendi şeması). mobile/e2e/README.md
ui_tests = project.targets.find { |t| t.name == 'AppUITests' }
unless ui_tests
  ui_tests = project.new_target(:ui_test_bundle, 'AppUITests', :ios, '15.0')
  ui_tests.add_dependency(app)
end
ui_tests.build_configurations.each do |c|
  c.build_settings.merge!(
    'TEST_TARGET_NAME' => 'App',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'SWIFT_VERSION' => '5.0',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'INFOPLIST_FILE' => 'AppUITests/Info.plist',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.kodviva.geckomail.uitests',
    'IPHONEOS_DEPLOYMENT_TARGET' => '15.0'
  )
end
ui_group = project.main_group['AppUITests'] || project.main_group.new_group('AppUITests', 'AppUITests')
add_sources(project, ui_tests, ui_group, Dir.children(File.join(root, 'AppUITests')).grep(/\.swift$/).sort)

project.save

ui_scheme = Xcodeproj::XCScheme.new
ui_scheme.configure_with_targets(ui_tests, ui_tests, launch_target: false)
ui_scheme.test_action.add_testable(Xcodeproj::XCScheme::TestAction::TestableReference.new(ui_tests)) if ui_scheme.test_action.testables.empty?
ui_scheme.save_as(File.join(root, 'App.xcodeproj'), 'AppUITests', true)

scheme_path = Xcodeproj::XCScheme.shared_data_dir(File.join(root, 'App.xcodeproj'))
scheme_file = File.join(scheme_path, 'App.xcscheme')
scheme = File.exist?(scheme_file) ? Xcodeproj::XCScheme.new(scheme_file) : Xcodeproj::XCScheme.new
scheme.configure_with_targets(app, tests, launch_target: true) unless File.exist?(scheme_file)
scheme.add_test_target(tests) if scheme.test_action.testables.empty?
scheme.save_as(File.join(root, 'App.xcodeproj'), 'App', true)
