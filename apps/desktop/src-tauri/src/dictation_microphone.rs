//! Which microphone dictation records from, and the microphone test in
//! Settings → Dictation.
//!
//! The choice is stored by the device's stable id (the CoreAudio device UID
//! on a Mac, the endpoint id on Windows), never by its place in the list,
//! with its name beside it so a missing device can still be named. Absent:
//! the system default. A chosen device that is not connected at the press
//! falls back to the system default, and the dictation notice says so.
//!
//! The test opens the selected device and reports only levels: the audio
//! stays in memory for the meter and is never stored, sent or transcribed.

#![cfg_attr(
  not(dictation),
  allow(
    dead_code,
    reason = "only builds with the speech engine open microphones"
  )
)]

use std::time::Duration;

use serde::Serialize;

pub const PREFERENCE_FILE_NAME: &str = "dictation-microphone";

/// An input device as Settings lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
  /// Stable across reconnects and restarts; what the choice stores.
  pub id: String,
  pub name: String,
  /// Bluetooth headsets switch profile before their microphone records,
  /// and record at lower quality.
  pub bluetooth: bool,
}

/// The stored choice of microphone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
  pub id: String,
  /// The name when it was chosen, to name it while it is not connected.
  pub name: String,
}

impl Choice {
  /// The preference file's contents: the id, then the name, one per line.
  pub fn stored(&self) -> String {
    format!("{}\n{}", self.id, self.name)
  }

  /// The stored choice; `None` for the system default or anything unreadable.
  pub fn parse(stored: Option<&str>) -> Option<Self> {
    let (id, name) = stored?.split_once('\n')?;
    let id = id.trim();
    if id.is_empty() {
      return None;
    }
    let name = name.trim();
    Some(Self {
      id: id.to_string(),
      name: if name.is_empty() { id } else { name }.to_string(),
    })
  }
}

/// Which device a dictation opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution<'a> {
  /// No choice: the system default.
  Default,
  /// The chosen device, connected.
  Chosen(&'a InputDevice),
  /// The chosen device is not connected: the system default instead.
  Missing { chosen: &'a str },
}

pub fn resolve<'a>(
  choice: Option<&'a Choice>,
  devices: &'a [InputDevice],
) -> Resolution<'a> {
  let Some(choice) = choice else {
    return Resolution::Default;
  };
  devices.iter().find(|device| device.id == choice.id).map_or(
    Resolution::Missing {
      chosen: &choice.name,
    },
    Resolution::Chosen,
  )
}

/// What Settings lists: the system default first, then every input device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophonesSnapshot {
  /// The system default's name right now, for "System default (<name>)".
  pub default_name: Option<String>,
  pub devices: Vec<InputDevice>,
  /// The chosen device's id; `None` for the system default.
  pub chosen: Option<String>,
  /// The chosen device's name while it is not connected.
  pub chosen_missing: Option<String>,
}

pub fn snapshot(
  choice: Option<&Choice>,
  devices: Vec<InputDevice>,
  default_name: Option<String>,
) -> MicrophonesSnapshot {
  let chosen_missing = match resolve(choice, &devices) {
    Resolution::Missing { chosen } => Some(chosen.to_string()),
    Resolution::Default | Resolution::Chosen(_) => None,
  };
  MicrophonesSnapshot {
    default_name,
    devices,
    chosen: choice.map(|choice| choice.id.clone()),
    chosen_missing,
  }
}

/// How often the test reports a level: about 25 times a second.
pub const LEVEL_INTERVAL: Duration = Duration::from_millis(40);
/// The test stops on its own after this long.
pub const TEST_LIMIT: Duration = Duration::from_secs(15);
/// Silence this long says nothing is coming from the device.
pub const SILENCE_LIMIT: Duration = Duration::from_secs(3);
/// The quietest level reported; silence and exact zeros read as this.
pub const FLOOR_DB: f32 = -90.0;
/// Speech near a microphone sits well above this; a quiet room below it.
const SPEECH_DB: f32 = -45.0;
/// Below this is silence, the level `dictation_audio` treats as quiet.
const SILENCE_DB: f32 = -54.0;
/// How fast the shown level falls back after a sound, in dB per second.
const RELEASE_DB_PER_SECOND: f32 = 30.0;
/// How fast the peak hold falls back, in dB per second.
const PEAK_RELEASE_DB_PER_SECOND: f32 = 12.0;

/// What the test says about the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TestStatus {
  /// Listening; nothing decided yet.
  Listening,
  /// Speech-level sound arrived.
  Hearing,
  /// Only near-silence for `SILENCE_LIMIT`.
  Silent,
  /// Exact zeros for `SILENCE_LIMIT`: the OS is withholding the microphone.
  Zeros,
}

/// One report for the meter: levels only, never samples.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelReading {
  /// Smoothed RMS level in dBFS, `FLOOR_DB` at its quietest.
  pub level_db: f32,
  /// Recent peak in dBFS, held and released slowly.
  pub peak_db: f32,
  pub status: TestStatus,
  /// The test reached `TEST_LIMIT` and stopped.
  pub finished: bool,
}

/// Turns captured audio into meter readings. Pure: time is a monotonic
/// offset from the test's start, handed in by the caller.
#[derive(Debug)]
pub struct LevelMeter {
  level_db: f32,
  peak_db: f32,
  last: Duration,
  heard: bool,
  /// Whether anything but exact zeros has arrived.
  any_signal: bool,
  /// Whether anything above silence has arrived.
  any_sound: bool,
}

impl Default for LevelMeter {
  fn default() -> Self {
    Self {
      level_db: FLOOR_DB,
      peak_db: FLOOR_DB,
      last: Duration::ZERO,
      heard: false,
      any_signal: false,
      any_sound: false,
    }
  }
}

/// The RMS and peak of `samples` in dBFS, floored.
pub fn levels(samples: &[f32]) -> (f32, f32) {
  if samples.is_empty() {
    return (FLOOR_DB, FLOOR_DB);
  }
  let energy = samples
    .iter()
    .map(|sample| f64::from(*sample).powi(2))
    .sum::<f64>()
    / samples.len() as f64;
  let peak = samples
    .iter()
    .map(|sample| sample.abs())
    .fold(0.0_f32, f32::max);
  (to_db(energy.sqrt() as f32), to_db(peak))
}

fn to_db(amplitude: f32) -> f32 {
  if amplitude <= 0.0 {
    return FLOOR_DB;
  }
  (20.0 * amplitude.log10()).max(FLOOR_DB)
}

impl LevelMeter {
  /// Reads the audio captured since the last reading, at `now`.
  pub fn push(&mut self, samples: &[f32], now: Duration) -> LevelReading {
    let elapsed = now.saturating_sub(self.last).as_secs_f32();
    self.last = now;
    let (rms, peak) = levels(samples);
    self.any_signal |= samples.iter().any(|sample| *sample != 0.0);
    self.any_sound |= rms > SILENCE_DB;
    self.heard |= rms >= SPEECH_DB;
    // Rises at once, falls back gently, so the bar does not flicker.
    self.level_db = rms.max(self.level_db - RELEASE_DB_PER_SECOND * elapsed);
    self.peak_db = peak.max(self.peak_db - PEAK_RELEASE_DB_PER_SECOND * elapsed);
    LevelReading {
      level_db: self.level_db.max(FLOOR_DB),
      peak_db: self.peak_db.max(FLOOR_DB),
      status: self.status(now),
      finished: now >= TEST_LIMIT,
    }
  }

  fn status(&self, now: Duration) -> TestStatus {
    if self.heard {
      TestStatus::Hearing
    } else if now < SILENCE_LIMIT || self.any_sound {
      TestStatus::Listening
    } else if self.any_signal {
      TestStatus::Silent
    } else {
      TestStatus::Zeros
    }
  }
}

/// Settings' list right now.
pub fn list() -> MicrophonesSnapshot {
  let choice = crate::dictation::microphone_choice();
  #[cfg(dictation)]
  {
    snapshot(
      choice.as_ref(),
      crate::dictation_engine::input_devices(),
      crate::dictation_engine::default_input().map(|device| device.name),
    )
  }
  #[cfg(not(dictation))]
  {
    snapshot(choice.as_ref(), Vec::new(), None)
  }
}

/// Stores `id` as the choice, with the name it has now; `None` clears it.
pub fn choose(id: Option<&str>) -> Result<MicrophonesSnapshot, String> {
  let preference =
    crate::device_preference::DevicePreference::in_app_data(PREFERENCE_FILE_NAME);
  match id {
    None => preference.write("")?,
    Some(id) => {
      let current = list();
      let device = current
        .devices
        .iter()
        .find(|device| device.id == id)
        .ok_or_else(|| "this microphone is not connected".to_string())?;
      preference.write(
        &Choice {
          id: device.id.clone(),
          name: device.name.clone(),
        }
        .stored(),
      )?;
    }
  }
  Ok(list())
}

/// The microphone test that is running, if any.
#[derive(Default)]
pub struct MicrophoneTest(std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>>);

impl MicrophoneTest {
  fn replace(&self, next: Option<std::sync::mpsc::Sender<()>>) {
    // Dropping the previous sender stops its test.
    *self.0.lock().unwrap_or_else(|error| error.into_inner()) = next;
  }
}

/// Payload of `LEVEL_EVENT`: levels only, never samples.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LevelEvent {
  #[serde(flatten)]
  reading: LevelReading,
  /// The device the test listens to.
  device: Option<String>,
}

/// Sent to the window that started the test (Settings or setup) about 25
/// times a second while it runs.
const LEVEL_EVENT: &str = "dictation-microphone-level";
/// Payload-free: the test stopped, on its own or when asked.
const ENDED_EVENT: &str = "dictation-microphone-test-ended";

/// Stops a running test; nothing when none runs.
pub fn stop_test(app: &tauri::AppHandle) {
  use tauri::Manager;
  if let Some(test) = app.try_state::<MicrophoneTest>() {
    test.replace(None);
  }
}

#[cfg(dictation)]
fn run_test(
  app: &tauri::AppHandle,
  target: &str,
  choice: Option<Choice>,
  stopped: &std::sync::mpsc::Receiver<()>,
) {
  use std::{sync::mpsc::RecvTimeoutError, time::Instant};

  use tauri::Emitter;

  let Some(recorder) = crate::dictation_engine::Recorder::start(choice) else {
    let reading = LevelMeter::default().push(&[], SILENCE_LIMIT);
    crate::logging::best_effort(
      app.emit_to(
        target,
        LEVEL_EVENT,
        LevelEvent {
          reading,
          device: None,
        },
      ),
      "microphone level was not sent",
    );
    crate::logging::best_effort(
      app.emit_to(target, ENDED_EVENT, ()),
      "test end was not sent",
    );
    return;
  };
  let started = Instant::now();
  let mut meter = LevelMeter::default();
  // A stop or a dropped sender ends it; a timeout is the next reading.
  while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(LEVEL_INTERVAL) {
    let mono = crate::dictation_audio::to_mono(&recorder.take(), recorder.channels);
    let reading = meter.push(&mono, started.elapsed());
    crate::logging::best_effort(
      app.emit_to(
        target,
        LEVEL_EVENT,
        LevelEvent {
          reading,
          device: recorder.device.clone(),
        },
      ),
      "microphone level was not sent",
    );
    if reading.finished {
      break;
    }
  }
  drop(recorder);
  crate::logging::best_effort(
    app.emit_to(target, ENDED_EVENT, ()),
    "test end was not sent",
  );
}

/// Listens to `id`, or the system default, and sends its level to the
/// window that asked until it is stopped or `TEST_LIMIT` passes. Refused
/// while a dictation records.
#[tauri::command]
pub async fn dictation_test_microphone_start(
  app: tauri::AppHandle,
  window: tauri::WebviewWindow,
  id: Option<String>,
) -> Result<(), String> {
  use tauri::Manager;
  if crate::dictation::recording(&app) {
    return Err("a dictation is recording".to_string());
  }
  #[cfg(dictation)]
  {
    let choice = id.map(|id| Choice {
      name: id.clone(),
      id,
    });
    let (stop, stopped) = std::sync::mpsc::channel();
    app.state::<MicrophoneTest>().replace(Some(stop));
    let test_app = app.clone();
    let target = window.label().to_string();
    std::thread::Builder::new()
      .name("dictation-microphone-test".to_string())
      .spawn(move || run_test(&test_app, &target, choice, &stopped))
      .map(|_| ())
      .map_err(crate::logging::with_cause_logged(
        "the microphone test could not start",
      ))
  }
  #[cfg(not(dictation))]
  {
    let _ = (app.state::<MicrophoneTest>(), window, id);
    Err("dictation is not available on this computer".to_string())
  }
}

#[tauri::command]
pub async fn dictation_test_microphone_stop(
  app: tauri::AppHandle,
) -> Result<(), String> {
  stop_test(&app);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn device(id: &str, name: &str) -> InputDevice {
    InputDevice {
      id: id.to_string(),
      name: name.to_string(),
      bluetooth: false,
    }
  }

  fn tone(amplitude: f32, count: usize) -> Vec<f32> {
    (0..count)
      .map(|index| amplitude * (index as f32 * 0.3).sin())
      .collect()
  }

  const fn ms(millis: u64) -> Duration {
    Duration::from_millis(millis)
  }

  #[test]
  fn a_choice_is_stored_by_id_with_its_name() {
    let choice = Choice {
      id: "coreaudio:BuiltInMicrophoneDevice".to_string(),
      name: "Built-in Microphone".to_string(),
    };

    assert_eq!(Choice::parse(Some(&choice.stored())), Some(choice));
  }

  #[test]
  fn no_choice_or_an_unreadable_one_is_the_system_default() {
    assert_eq!(Choice::parse(None), None);
    assert_eq!(Choice::parse(Some("")), None);
    assert_eq!(Choice::parse(Some("no name line")), None);
    assert_eq!(Choice::parse(Some("  \nAirPods")), None);
    // A name lost on the way still names the device by its id.
    assert_eq!(
      Choice::parse(Some("coreaudio:A\n")).map(|choice| choice.name),
      Some("coreaudio:A".to_string())
    );
  }

  #[test]
  fn the_chosen_device_is_found_by_id_whatever_its_place_in_the_list() {
    let devices = [
      device("b", "AirPods Pro 3"),
      device("a", "Built-in Microphone"),
    ];
    let choice = Choice {
      id: "a".to_string(),
      name: "Built-in Microphone".to_string(),
    };

    assert_eq!(
      resolve(Some(&choice), &devices),
      Resolution::Chosen(&devices[1])
    );
    assert_eq!(resolve(None, &devices), Resolution::Default);
  }

  #[test]
  fn a_missing_device_falls_back_to_the_default_and_is_named() {
    let devices = [device("b", "AirPods Pro 3")];
    let choice = Choice {
      id: "usb".to_string(),
      name: "Desk Microphone".to_string(),
    };

    assert_eq!(
      resolve(Some(&choice), &devices),
      Resolution::Missing {
        chosen: "Desk Microphone"
      }
    );
    let listed = snapshot(
      Some(&choice),
      devices.to_vec(),
      Some("AirPods Pro 3".into()),
    );
    assert_eq!(listed.chosen.as_deref(), Some("usb"));
    assert_eq!(listed.chosen_missing.as_deref(), Some("Desk Microphone"));
    assert_eq!(listed.default_name.as_deref(), Some("AirPods Pro 3"));
  }

  #[test]
  fn levels_are_dbfs_and_silence_is_the_floor() {
    assert_eq!(levels(&[]), (FLOOR_DB, FLOOR_DB));
    assert_eq!(levels(&[0.0; 64]), (FLOOR_DB, FLOOR_DB));
    let (rms, peak) = levels(&[1.0, -1.0, 1.0, -1.0]);
    assert!(rms.abs() < 0.01 && peak.abs() < 0.01, "{rms} {peak}");
    let (rms, _) = levels(&[0.1; 64]);
    assert!((rms + 20.0).abs() < 0.01, "{rms}");
  }

  #[test]
  fn the_level_rises_at_once_and_falls_back_gently() {
    let mut meter = LevelMeter::default();
    let loud = meter.push(&tone(0.5, 640), ms(40));
    assert!(loud.level_db > -12.0, "{loud:?}");

    let after = meter.push(&[0.0; 640], ms(80));
    // 40 ms of release, not a drop to the floor.
    assert!(after.level_db < loud.level_db);
    assert!(after.level_db > loud.level_db - 2.0, "{after:?}");
    assert!(after.peak_db > after.level_db);
  }

  #[test]
  fn speech_level_sound_is_heard_and_stays_heard() {
    let mut meter = LevelMeter::default();
    assert_eq!(
      meter.push(&tone(0.001, 640), ms(40)).status,
      TestStatus::Listening
    );
    assert_eq!(
      meter.push(&tone(0.2, 640), ms(80)).status,
      TestStatus::Hearing
    );
    assert_eq!(
      meter.push(&[0.0; 640], ms(5_000)).status,
      TestStatus::Hearing
    );
  }

  #[test]
  fn exact_zeros_for_three_seconds_say_the_microphone_is_withheld() {
    let mut meter = LevelMeter::default();
    assert_eq!(
      meter.push(&[0.0; 640], ms(2_960)).status,
      TestStatus::Listening
    );
    assert_eq!(meter.push(&[0.0; 640], ms(3_000)).status, TestStatus::Zeros);
  }

  #[test]
  fn near_silence_for_three_seconds_says_no_sound() {
    let mut meter = LevelMeter::default();
    let hiss = tone(0.000_5, 640);
    assert_eq!(meter.push(&hiss, ms(2_000)).status, TestStatus::Listening);
    assert_eq!(meter.push(&hiss, ms(3_000)).status, TestStatus::Silent);
  }

  #[test]
  fn the_test_finishes_after_its_limit() {
    let mut meter = LevelMeter::default();
    assert!(!meter.push(&[0.0; 64], TEST_LIMIT - ms(1)).finished);
    assert!(meter.push(&[0.0; 64], TEST_LIMIT).finished);
  }
}
