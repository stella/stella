Pod::Spec.new do |s|
  s.name           = 'DocumentScanner'
  s.version        = '1.0.0'
  s.summary        = 'Scans paper with the system document camera and binds the pages into a PDF.'
  s.description    = 'Presents the VisionKit document camera, keeps each scanned page as an image, and binds the pages into one PDF on request.'
  s.author         = ''
  s.homepage       = 'https://stll.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'VisionKit', 'CoreGraphics'
  s.source_files = '**/*.swift'
end
