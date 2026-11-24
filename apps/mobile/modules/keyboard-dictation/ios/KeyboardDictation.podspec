Pod::Spec.new do |s|
  s.name           = 'KeyboardDictation'
  s.version        = '1.0.0'
  s.summary        = 'Dictation for the stella keyboard.'
  s.description    = 'Keeps the microphone open in the app for the stella keyboard, records what the keyboard asks for and hands the recordings to JavaScript.'
  s.author         = ''
  s.homepage       = 'https://stll.app'
  s.platforms      = { :ios => '26.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
