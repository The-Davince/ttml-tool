import type { QueueConfig } from "../types";

//#region Internal Constants
const CONTROL_BLOCK_BYTES = 128;

// Read-Only Configs (0-15)
const CONFIG_CHANNELS = 0;
const CONFIG_CAPACITY_FRAMES = 1;
const CONFIG_NOTIFY_FRAMES = 2;
const CONFIG_EMERGENCY_FRAMES = 3;

// Mutable States (16-31)
const STATE_PLAYING = 16;
const STATE_IS_SEEKING = 17;
const STATE_READ_INDEX = 18;
const STATE_WRITE_INDEX = 19;
const STATE_PLAYBACK_INDEX = 20;
const STATE_PAUSE_AT_INDEX = 21;
const STATE_SEEK_GENERATION = 22;
const STATE_UNNOTIFIED_FRAMES = 23;
//#endregion

//#region Public Interfaces
/**
 * Controls the global playback state and retrieves the current read position.
 *
 * Typically used by the main thread.
 */
export interface MainAudioController {
	play(): void;
	pause(): void;
	/**
	 * Returns the absolute number of frames consumed by the reader so far.
	 */
	getReadIndex(): number;
	getPlaybackIndex(): number;
	setSeeking(isSeeking: boolean): void;
	setPauseAtIndex(index: number): void;
	clearPauseAtIndex(): void;
}

/**
 * Provides write access to the audio queue.
 *
 * Typically used by the decoding worker.
 */
export interface AudioWriter {
	/**
	 * Returns the number of frames that can currently be written to the buffer.
	 */
	getAvailableWriteSpace(): number;

	/**
	 * Attempts to write audio frames into the buffer up to the available capacity.
	 *
	 * @param channelDatas An array of Float32Arrays representing planar audio channels.
	 * @param offset The starting index in the source arrays.
	 * @param length The number of frames to write.
	 * @returns The actual number of frames written.
	 */
	writePartial(
		channelDatas: Float32Array[],
		offset: number,
		length: number,
	): number;

	/**
	 * Suspends reading operations and resets the read/write indices for seeking.
	 */
	beginSeek(): void;

	/**
	 * Resumes normal operations after a seek.
	 */
	endSeek(): void;

	/**
	 * Asynchronously waits until the consumer frees up space in the buffer.
	 *
	 * @returns An object indicating whether the thread was suspended. If `async` is true,
	 * the `promise` resolves when space might be available.
	 */
	waitForSpaceAsync(minSpaceReq: number): {
		async: boolean;
		promise?: Promise<void>;
	};

	/**
	 * Asynchronously waits until all data currently in the buffer has been consumed.
	 *
	 * @returns An object indicating whether the buffer is fully drained. If not, and it
	 * suspended successfully, the `promise` resolves when the state changes.
	 */
	waitForDrainAsync(): { isDrained: boolean; promise?: Promise<void> };
}

/**
 * Provides read access to the audio queue.
 *
 * Typically used by the AudioWorkletProcessor.
 */
export interface AudioReader {
	/**
	 * Returns true if the playback state is currently set to playing.
	 */
	isPlaying(): boolean;
	/**
	 * Returns true if the player is currently seeking.
	 */
	isSeeking(): boolean;
	/**
	 * Probe: Returns the number of actual audio frames available to read in the buffer.
	 */
	getAvailableReadFrames(): number;
	/**
	 * Pulls a specific number of audio frames from the buffer into the output arrays.
	 * Does NOT pad with silence. Returns only the actual number of frames read.
	 *
	 * @param outputs An array of Float32Arrays representing destination channels (often mapped to Wasm memory).
	 * @param length The maximum number of frames requested.
	 * @returns The actual number of frames successfully read.
	 */
	readPartial(outputs: Float32Array[], length: number): number;
	addPlaybackIndex(frames: number): void;
	getPlaybackIndex(): number;
	rewindReadIndexToPlayback(): void;
	getPauseAtIndex(): number;
	clearPauseAtIndex(): void;
	pausePlayback(): void;
	getSeekGeneration(): number;
}
//#endregion

	//#region Core Implementation
class AudioQueueCore implements MainAudioController, AudioWriter, AudioReader {
	private controlBlock: Int32Array;
	private channelBuffers: Float32Array[] = [];
	private channels: number;
	private capacityFrames: number;

	constructor(sab: SharedArrayBuffer) {
		this.controlBlock = new Int32Array(sab, 0, CONTROL_BLOCK_BYTES / 4);

		this.channels = Atomics.load(this.controlBlock, CONFIG_CHANNELS);
		this.capacityFrames = Atomics.load(
			this.controlBlock,
			CONFIG_CAPACITY_FRAMES,
		);

		const bytesPerChannel = this.capacityFrames * 4;
		for (let c = 0; c < this.channels; c++) {
			const offset = CONTROL_BLOCK_BYTES + c * bytesPerChannel;
			this.channelBuffers.push(
				new Float32Array(sab, offset, this.capacityFrames),
			);
		}
	}

	// Int32 索引单调累加约 13.5 小时(44.1kHz)后回绕为负, 差值需按 2^32 周期归一化
	private normDelta(a: number, b: number): number {
		const diff = a - b;
		return diff < 0 ? diff + 0x100000000 : diff;
	}

	// 回绕后的负索引取环位置, % 在 JS 里会返回负数
	private ringPosOf(index: number): number {
		const pos = index % this.capacityFrames;
		return pos < 0 ? pos + this.capacityFrames : pos;
	}

	//#region MainAudioController
	play(): void {
		Atomics.store(this.controlBlock, STATE_PLAYING, 1);
	}

	pause(): void {
		Atomics.store(this.controlBlock, STATE_PLAYING, 0);
	}

	getReadIndex(): number {
		return Atomics.load(this.controlBlock, STATE_READ_INDEX);
	}

	getPlaybackIndex(): number {
		return Atomics.load(this.controlBlock, STATE_PLAYBACK_INDEX);
	}

	setSeeking(isSeeking: boolean): void {
		Atomics.store(this.controlBlock, STATE_IS_SEEKING, isSeeking ? 1 : 0);
	}

	setPauseAtIndex(index: number): void {
		Atomics.store(this.controlBlock, STATE_PAUSE_AT_INDEX, index);
	}

	clearPauseAtIndex(): void {
		Atomics.store(this.controlBlock, STATE_PAUSE_AT_INDEX, -1);
	}
	//#endregion

	//#region AudioWriter
	getAvailableWriteSpace(): number {
		const writeIndex = Atomics.load(this.controlBlock, STATE_WRITE_INDEX);
		const readIndex = Atomics.load(this.controlBlock, STATE_READ_INDEX);
		return this.capacityFrames - this.normDelta(writeIndex, readIndex);
	}

	writePartial(
		channelDatas: Float32Array[],
		offset: number,
		length: number,
	): number {
		const writeIndex = Atomics.load(this.controlBlock, STATE_WRITE_INDEX);
		const readIndex = Atomics.load(this.controlBlock, STATE_READ_INDEX);

		const availableSpace =
			this.capacityFrames - this.normDelta(writeIndex, readIndex);
		const writeAmount = Math.min(length, availableSpace);

		if (writeAmount === 0) {
			return 0;
		}

		const ringPos = this.ringPosOf(writeIndex);
		const spaceToEnd = this.capacityFrames - ringPos;

		for (let c = 0; c < this.channels; c++) {
			const source = channelDatas[c];
			const target = this.channelBuffers[c];

			if (writeAmount <= spaceToEnd) {
				target.set(source.subarray(offset, offset + writeAmount), ringPos);
			} else {
				target.set(source.subarray(offset, offset + spaceToEnd), ringPos);
				target.set(
					source.subarray(offset + spaceToEnd, offset + writeAmount),
					0,
				);
			}
		}

		Atomics.add(this.controlBlock, STATE_WRITE_INDEX, writeAmount);
		return writeAmount;
	}

	beginSeek(): void {
		Atomics.store(this.controlBlock, STATE_IS_SEEKING, 1);
		Atomics.store(this.controlBlock, STATE_WRITE_INDEX, 0);
		Atomics.store(this.controlBlock, STATE_READ_INDEX, 0);
		Atomics.store(this.controlBlock, STATE_PLAYBACK_INDEX, 0);
		Atomics.store(this.controlBlock, STATE_UNNOTIFIED_FRAMES, 0);
		Atomics.add(this.controlBlock, STATE_SEEK_GENERATION, 1);
		Atomics.notify(this.controlBlock, STATE_READ_INDEX, 1);
	}

	endSeek(): void {
		Atomics.store(this.controlBlock, STATE_IS_SEEKING, 0);
	}

	waitForSpaceAsync(minSpaceReq: number): {
		async: boolean;
		promise?: Promise<void>;
	} {
		const writeIndex = Atomics.load(this.controlBlock, STATE_WRITE_INDEX);
		const readIndex = Atomics.load(this.controlBlock, STATE_READ_INDEX);

		const availableSpace =
			this.capacityFrames - this.normDelta(writeIndex, readIndex);

		if (availableSpace >= minSpaceReq) {
			return { async: false };
		}

		const currentReadIndex = readIndex;
		const waitResult = Atomics.waitAsync(
			this.controlBlock,
			STATE_READ_INDEX,
			currentReadIndex,
		);

		if (waitResult.async) {
			const voidPromise = (waitResult.value as Promise<string>).then(() => {});
			return { async: true, promise: voidPromise };
		}

		return { async: false };
	}

	waitForDrainAsync(): { isDrained: boolean; promise?: Promise<void> } {
		const writeIndex = Atomics.load(this.controlBlock, STATE_WRITE_INDEX);
		const readIndex = Atomics.load(this.controlBlock, STATE_READ_INDEX);

		if (this.normDelta(writeIndex, readIndex) === 0) {
			return { isDrained: true };
		}

		const waitResult = Atomics.waitAsync(
			this.controlBlock,
			STATE_READ_INDEX,
			readIndex,
		);

		if (waitResult.async) {
			const voidPromise = (waitResult.value as Promise<string>).then(() => {});
			return { isDrained: false, promise: voidPromise };
		}

		return { isDrained: false };
	}

	getSeekGeneration(): number {
		return Atomics.load(this.controlBlock, STATE_SEEK_GENERATION);
	}
	//#endregion

	//#region AudioReader
	isPlaying(): boolean {
		return Atomics.load(this.controlBlock, STATE_PLAYING) === 1;
	}

	isSeeking(): boolean {
		return Atomics.load(this.controlBlock, STATE_IS_SEEKING) === 1;
	}

	getAvailableReadFrames(): number {
		const writeIndex = Atomics.load(this.controlBlock, STATE_WRITE_INDEX);
		const readIndex = Atomics.load(this.controlBlock, STATE_READ_INDEX);
		return this.normDelta(writeIndex, readIndex);
	}

	readPartial(outputs: Float32Array[], length: number): number {
		if (!this.isPlaying() || this.isSeeking()) {
			return 0;
		}

		const writeIndex = Atomics.load(this.controlBlock, STATE_WRITE_INDEX);
		const readIndex = Atomics.load(this.controlBlock, STATE_READ_INDEX);
		const availableData = this.normDelta(writeIndex, readIndex);
		const readAmount = Math.min(length, availableData);

		if (readAmount === 0) {
			return 0;
		}

		const ringPos = this.ringPosOf(readIndex);
		const spaceToEnd = this.capacityFrames - ringPos;
		for (let c = 0; c < this.channels; c++) {
			if (!outputs[c]) continue;
			if (readAmount <= spaceToEnd) {
				outputs[c].set(
					this.channelBuffers[c].subarray(ringPos, ringPos + readAmount),
				);
			} else {
				outputs[c].set(
					this.channelBuffers[c].subarray(ringPos, this.capacityFrames),
					0,
				);
				const remaining = readAmount - spaceToEnd;
				outputs[c].set(
					this.channelBuffers[c].subarray(0, remaining),
					spaceToEnd,
				);
			}
		}

		Atomics.add(this.controlBlock, STATE_READ_INDEX, readAmount);
		Atomics.add(this.controlBlock, STATE_UNNOTIFIED_FRAMES, readAmount);
		this.notifyProducerIfNeeded(availableData - readAmount);
		return readAmount;
	}

	addPlaybackIndex(frames: number): void {
		Atomics.add(this.controlBlock, STATE_PLAYBACK_INDEX, frames);
	}

	rewindReadIndexToPlayback(): void {
		const playbackIndex = Atomics.load(this.controlBlock, STATE_PLAYBACK_INDEX);
		const writeIndex = Atomics.load(this.controlBlock, STATE_WRITE_INDEX);
		// 两个索引同周期内单调累加, 回绕后差值仍表示落后帧数
		const behind = this.normDelta(writeIndex, playbackIndex);
		const targetIndex = behind > 0 ? writeIndex - behind : writeIndex;
		Atomics.store(this.controlBlock, STATE_READ_INDEX, targetIndex);
	}

	getPauseAtIndex(): number {
		return Atomics.load(this.controlBlock, STATE_PAUSE_AT_INDEX);
	}

	pausePlayback(): void {
		Atomics.store(this.controlBlock, STATE_PLAYING, 0);
	}

	private notifyProducerIfNeeded(availableData: number): void {
		const unnotified = Atomics.load(this.controlBlock, STATE_UNNOTIFIED_FRAMES);

		const notifyFrames = Atomics.load(this.controlBlock, CONFIG_NOTIFY_FRAMES);
		const emergencyFrames = Atomics.load(
			this.controlBlock,
			CONFIG_EMERGENCY_FRAMES,
		);

		if (unnotified >= notifyFrames || availableData < emergencyFrames) {
			Atomics.store(this.controlBlock, STATE_UNNOTIFIED_FRAMES, 0);
			Atomics.notify(this.controlBlock, STATE_READ_INDEX, 1);
		}
	}
	//#endregion
}
//#endregion

//#region Public Allocators & Factories
/**
 * Allocates the shared memory required for the audio queue.
 *
 * @param channels The number of audio channels.
 * @returns A strictly sized SharedArrayBuffer.
 */
export function allocateAudioQueueMemory(
	sampleRate: number,
	channels: number,
	config: Required<QueueConfig>,
): SharedArrayBuffer {
	const capacityFrames =
		Math.ceil((config.capacitySeconds * sampleRate) / 128) * 128;
	const notifyFrames = Math.round(config.notifyWatermarkSeconds * sampleRate);
	const emergencyFrames = Math.round(
		config.emergencyWatermarkSeconds * sampleRate,
	);

	const bytesPerChannel = capacityFrames * 4;
	const sabBytes = CONTROL_BLOCK_BYTES + bytesPerChannel * channels;
	const sab = new SharedArrayBuffer(sabBytes);

	const controlBlock = new Int32Array(sab, 0, CONTROL_BLOCK_BYTES / 4);

	Atomics.store(controlBlock, CONFIG_CHANNELS, channels);
	Atomics.store(controlBlock, CONFIG_CAPACITY_FRAMES, capacityFrames);
	Atomics.store(controlBlock, CONFIG_NOTIFY_FRAMES, notifyFrames);
	Atomics.store(controlBlock, CONFIG_EMERGENCY_FRAMES, emergencyFrames);

	Atomics.store(controlBlock, STATE_PAUSE_AT_INDEX, -1);
	Atomics.store(controlBlock, STATE_UNNOTIFIED_FRAMES, 0);

	return sab;
}

/**
 * Creates the controller interface for the main thread.
 */
export function createMainController(
	sab: SharedArrayBuffer,
): MainAudioController {
	return new AudioQueueCore(sab);
}

/**
 * Creates the writer interface for the decoding worker.
 */
export function createAudioWriter(sab: SharedArrayBuffer): AudioWriter {
	return new AudioQueueCore(sab);
}

/**
 * Creates the reader interface for the audio worklet.
 */
export function createAudioReader(sab: SharedArrayBuffer): AudioReader {
	return new AudioQueueCore(sab);
}
//#endregion
