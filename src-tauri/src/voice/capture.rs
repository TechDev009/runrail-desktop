//! The microphone, through cpal (Core Audio on macOS, ALSA on Linux): the input devices this
//! computer has, and a mono stream from one of them. Samples are only passed on to the recognizer;
//! nothing is written anywhere.

use std::sync::mpsc::SyncSender;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, Stream, StreamConfig};
use serde::Serialize;

use crate::error::{BridgeError, BridgeResult};

#[cfg(target_os = "macos")]
const NO_MICROPHONE: &str = "this Mac has no microphone input";
#[cfg(not(target_os = "macos"))]
const NO_MICROPHONE: &str = "this computer has no microphone input";

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub default: bool,
}

pub fn devices() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|device| device.id().ok()).map(|id| id.to_string());
    let Ok(inputs) = host.input_devices() else {
        return Vec::new();
    };
    inputs
        .filter_map(|device| {
            let id = device.id().ok()?.to_string();
            Some(InputDevice { default: default.as_deref() == Some(id.as_str()), name: device.to_string(), id })
        })
        .take(64)
        .collect()
}

fn mono<T>(data: &[T], channels: usize) -> Vec<f32>
where
    T: Copy,
    f32: FromSample<T>,
{
    let channels = channels.max(1);
    data.chunks(channels).map(|frame| frame.iter().map(|&sample| f32::from_sample_(sample)).sum::<f32>() / frame.len() as f32).collect()
}

fn build<T>(device: &cpal::Device, config: &StreamConfig, sink: SyncSender<Vec<f32>>) -> Result<Stream, cpal::Error>
where
    T: SizedSample + Copy + Send + 'static,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    // A full queue drops the chunk rather than blocking the audio thread.
    device.build_input_stream::<T, _, _>(*config, move |data: &[T], _| drop(sink.try_send(mono(data, channels))), |_| {}, None)
}

/// Opens the named input, or the system's default, and starts it. Returns the stream, which
/// stops when dropped, and its sample rate.
pub fn open(id: Option<&str>, sink: SyncSender<Vec<f32>>) -> BridgeResult<(Stream, u32)> {
    let host = cpal::default_host();
    let device = match id {
        Some(id) => {
            let wanted: cpal::DeviceId = id.parse().map_err(|_| BridgeError::new("VOICE_DEVICE_MISSING", "that microphone is not connected"))?;
            host.device_by_id(&wanted).ok_or_else(|| BridgeError::new("VOICE_DEVICE_MISSING", "that microphone is not connected"))?
        }
        None => host.default_input_device().ok_or_else(|| BridgeError::new("VOICE_NO_MICROPHONE", NO_MICROPHONE))?,
    };
    let supported = device.default_input_config().map_err(|_| BridgeError::new("VOICE_DEVICE_FAILED", "the microphone could not be opened"))?;
    let config = supported.config();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &config, sink),
        SampleFormat::I16 => build::<i16>(&device, &config, sink),
        SampleFormat::I32 => build::<i32>(&device, &config, sink),
        SampleFormat::U16 => build::<u16>(&device, &config, sink),
        _ => return Err(BridgeError::new("VOICE_DEVICE_FAILED", "the microphone uses a sample format Runrail cannot read")),
    }
    .map_err(|_| BridgeError::new("VOICE_DEVICE_FAILED", "the microphone could not be opened"))?;
    stream.play().map_err(|_| BridgeError::new("VOICE_DEVICE_FAILED", "the microphone could not start"))?;
    Ok((stream, config.sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_averaged_to_one_channel() {
        assert_eq!(mono(&[0.5f32, -0.5, 1.0, 0.0], 2), vec![0.0, 0.5]);
        assert_eq!(mono(&[i16::MAX, i16::MAX], 1).len(), 2);
    }
}
