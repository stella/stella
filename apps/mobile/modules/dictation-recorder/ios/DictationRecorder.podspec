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
  s.license = { :type => 'Apache-2.0' }
  s.dependency 'ExpoModulesCore'
  s.dependency 'StellaRNNoise', '1.0.0'
  s.frameworks = 'AVFoundation', 'CryptoKit', 'UIKit'
  s.source_files = '*.swift'
end
