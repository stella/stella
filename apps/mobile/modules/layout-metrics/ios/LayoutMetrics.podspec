Pod::Spec.new do |s|
  s.name           = 'LayoutMetrics'
  s.version        = '1.0.0'
  s.summary        = 'Reports the window geometry a layout needs, the fold included.'
  s.description    = 'An invisible view that reports its size class, safe area and the hinge reserved region.'
  s.author         = ''
  s.homepage       = 'https://stll.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
end
