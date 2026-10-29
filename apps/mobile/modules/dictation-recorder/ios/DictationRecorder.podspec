Pod::Spec.new do |s|
  s.name = 'DictationRecorder'
  s.version = '1.0.0'
  s.summary = 'Durable on-device dictation recording and audio export.'
  s.description = 'Captures recoverable audio drafts and exports AAC audio with optional local noise suppression.'
  s.author = ''
  s.homepage = 'https://stll.app'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.license = { :type => 'Apache-2.0 AND BSD-3-Clause', :file => 'rnnoise/COPYING' }
  s.resource_bundles = { 'DictationRecorderNotices' => ['rnnoise/COPYING', 'rnnoise/PROVENANCE'] }
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CryptoKit', 'UIKit'
  s.source_files = '**/*.{swift,c,h}'
  s.public_header_files = 'rnnoise/rnnoise.h'
  s.pod_target_xcconfig = { 'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) RNNOISE_BUILD=1' }
end
