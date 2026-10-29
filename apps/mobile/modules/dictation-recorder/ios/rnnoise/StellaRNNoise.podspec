Pod::Spec.new do |s|
  s.name = 'StellaRNNoise'
  s.version = '1.0.0'
  s.summary = 'On-device audio noise suppression.'
  s.author = ''
  s.homepage = 'https://github.com/xiph/rnnoise'
  s.platforms = { :ios => '16.4' }
  s.source = { git: 'https://github.com/xiph/rnnoise.git', :tag => 'v0.1' }
  s.license = { :type => 'BSD-3-Clause', :file => 'COPYING' }
  s.resource_bundles = { 'StellaRNNoiseNotices' => ['COPYING', 'PROVENANCE'] }
  s.source_files = '*.{c,h}'
  s.public_header_files = 'rnnoise.h'
  s.private_header_files = Dir.glob(File.join(__dir__, '*.h')).map { |header| File.basename(header) } - ['rnnoise.h']
  s.module_map = 'module.modulemap'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) RNNOISE_BUILD=1'
  }
end
