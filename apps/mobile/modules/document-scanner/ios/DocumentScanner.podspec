Pod::Spec.new do |s|
  s.name           = 'DocumentScanner'
  s.version        = '1.0.0'
  s.summary        = 'Scans paper into a PDF with the system document camera.'
  s.description    = 'Presents VisionKit document camera and writes the scanned pages into one PDF.'
  s.author         = ''
  s.homepage       = 'https://stll.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'VisionKit', 'PDFKit'
  s.source_files = '**/*.swift'
end
