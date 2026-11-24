Pod::Spec.new do |s|
  s.name           = 'DictationDevice'
  s.version        = '1.0.0'
  s.summary        = 'Routes a dictation to the iPhone microphone without stopping other audio.'
  s.description    = 'Sets the audio session a dictation records in and reports interruptions and a lost microphone.'
  s.author         = ''
  s.homepage       = 'https://stll.app'
  s.platforms      = { :ios => '26.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'AVFoundation'
  s.source_files = '**/*.swift'
end
