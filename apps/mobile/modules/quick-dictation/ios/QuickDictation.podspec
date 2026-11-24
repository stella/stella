Pod::Spec.new do |s|
  s.name           = 'QuickDictation'
  s.version        = '1.0.0'
  s.summary        = 'Dictation started from the Action Button, Siri or Control Center.'
  s.description    = 'Records a dictation in the background for an App Intent, cut at pauses, with a Live Activity to finish or cancel it, and hands the recording to the app to transcribe.'
  s.author         = ''
  s.homepage       = 'https://stll.app'
  s.platforms      = { :ios => '26.0' }
  s.source         = { git: '' }
  s.static_framework = true

  # ActivityKit's activities are not Sendable; Swift 6's checks would refuse
  # updating one from the main actor, which is where the session drives it.
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  # Only this folder's files; `targets/` holds the sources the app config
  # copies into the app and widget targets.
  s.source_files = '*.swift'
end
