Pod::Spec.new do |s|
  s.name           = 'DocumentFiles'
  s.version        = '1.0.0'
  s.summary        = 'Downloads a document for the viewer and previews it with Quick Look.'
  s.description    = 'Keeps an opened document in protected caches, hands its bytes to the viewer, and shows other files in Quick Look.'
  s.author         = ''
  s.homepage       = 'https://stll.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'QuickLook'
  s.source_files = '**/*.swift'
end
