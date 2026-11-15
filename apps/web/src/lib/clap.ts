// The clap of the logo's easter egg (lib/gassho.ts), played with the Web Audio API. The recording is "HandClap1.wav"
// by Landau00 on Freesound (CC0; https://freesound.org/people/Landau00/sounds/463687/), its MP3 preview as it is: the
// silence it starts with is skipped and its loudness evened out here, when it is played.
import clapUrl from "@/assets/clap.mp3";
import { soundStart } from "@/lib/gassho";

/** How loud the clap's loudest sample is played (1: full scale), made at most this many times louder than recorded. */
const LOUDNESS = 0.7;
const MAX_GAIN = 4;
/** Played from this long (s) before the sound starts, so that its attack is not cut. */
const LEAD_IN = 0.002;

interface Clap {
  buffer: AudioBuffer;
  /** Where the sound starts (s). */
  offset: number;
  gain: number;
}

let context: AudioContext | undefined;
let clap: Promise<Clap | undefined> | undefined;

/**
 * Lets the clap be heard later, and loads it the first time. Called from what the user does (a tap, a press, letting
 * go): a browser lets a page make sounds only once the page has started or resumed its audio from one of those (an
 * iPhone, from a tap or a release, not from the start of a press).
 */
export function prepareClap(): void {
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") context.resume().catch(() => {});
    clap ??= load(context);
  } catch {
    // No Web Audio: the egg goes on without a sound.
  }
}

async function load(audio: AudioContext): Promise<Clap | undefined> {
  try {
    const response = await fetch(clapUrl);
    if (!response.ok) return undefined;
    const buffer = await audio.decodeAudioData(await response.arrayBuffer());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const { start, peak } = soundStart(channels);
    return { buffer, offset: Math.max(0, start / buffer.sampleRate - LEAD_IN), gain: peak > 0 ? Math.min(MAX_GAIN, LOUDNESS / peak) : 1 };
  } catch {
    return undefined;
  }
}

/** Plays the clap now, when it has been loaded (otherwise nothing is heard). An iPhone in silent mode plays no sound. */
export function playClap(): void {
  const audio = context;
  void clap?.then((loaded) => {
    if (!audio || !loaded) return;
    const source = audio.createBufferSource();
    source.buffer = loaded.buffer;
    const gain = audio.createGain();
    gain.gain.value = loaded.gain;
    source.connect(gain).connect(audio.destination);
    source.start(0, loaded.offset);
  });
}
