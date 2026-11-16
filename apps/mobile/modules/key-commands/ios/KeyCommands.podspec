Pod::Spec.new do |s|
  s.name           = 'KeyCommands'
  s.version        = '1.0.0'
  s.summary        = 'Hardware keyboard shortcuts for the app.'
  s.description    = 'A view around the app that answers hardware keyboard shortcuts.'
  s.author         = ''
  s.homepage       = 'https://stll.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
