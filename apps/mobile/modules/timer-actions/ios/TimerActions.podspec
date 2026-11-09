Pod::Spec.new do |s|
  s.name           = 'TimerActions'
  s.version        = '1.0.0'
  s.summary        = 'Lock Screen timer buttons.'
  s.description    = 'Pauses and resumes the timer a Live Activity shows when its button is tapped, even with the app closed.'
  s.author         = ''
  s.homepage       = 'https://stll.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
