import { getErrorMessage } from "../utils";
import { acquireOpfsAccessHandle } from "./opfs-lock";
import type { FFmpegAudioModule } from "./types";
import initBpmWasm, {
	type BpmAnalysisResult,
	BpmAnalyzer,
	type InitOutput,
	initThreadPool,
} from "./wasm/bpm-analyzer/bpm_analyzer_wasm";
import createModule from "./wasm/ffmpeg/ffmpeg_wasm.js";

let bpmWasmInstance: InitOutput | null = null;
let bpmWasmInitPromise: Promise<InitOutput> | null = null;

async function getBpmWasm(): Promise<InitOutput> {
	if (bpmWasmInstance) return bpmWasmInstance;
	if (!bpmWasmInitPromise) {
		bpmWasmInitPromise = (async () => {
			const instance = await initBpmWasm();
			await initThreadPool(navigator.hardwareConcurrency);
			return instance;
		})();
	}
	bpmWasmInstance = await bpmWasmInitPromise;
	return bpmWasmInstance;
}

const THRESHOLD_50MB = 50 * 1024 * 1024;

let ffmpegModule: FFmpegAudioModule | null = null;
let audioData: Uint8Array | null = null;
let decoderPtr: number = 0;
let audioFile: Blob | null = null;
const readerSync = new FileReaderSync();

let totalSamples = 0;
let totalDuration = 0;
let isAnalyzing = false;

let opfsAccessHandle: FileSystemSyncAccessHandle | null = null;
let opfsFileHandle: FileSystemFileHandle | null = null;

const WRITE_BUFFER_CAPACITY = 1024 * 1024;
const pcmWriteBuffer = new Float32Array(WRITE_BUFFER_CAPACITY);
let pcmWriteOffset = 0;

const TARGET_SAMPLE_RATE = 44100;

const opfsChannel = new BroadcastChannel("opfs-lock-channel");

opfsChannel.onmessage = (e) => {
	if (e.data === "DEMAND_LOCK" && opfsAccessHandle) {
		try {
			if (pcmWriteOffset > 0) {
				opfsAccessHandle.write(pcmWriteBuffer.subarray(0, pcmWriteOffset), {
					at: totalSamples * 4 - pcmWriteOffset * 4,
				});
				pcmWriteOffset = 0;
			}
			opfsAccessHandle.flush();
			opfsAccessHandle.close();
		} catch (err) {
			console.warn("[Analyzer] release OPFS handle failed:", err);
		}
		opfsAccessHandle = null;
		opfsChannel.postMessage("OPFS_RELEASED");
	}
};

async function reacquireOpfsAccessHandle(): Promise<void> {
	if (opfsAccessHandle || !opfsFileHandle) return;
	opfsAccessHandle = await acquireOpfsAccessHandle(opfsFileHandle, opfsChannel);
}

const BATCH_TRIPLETS = 1000;
const BUFFER_SIZE = BATCH_TRIPLETS * 3;
const freePool: ArrayBuffer[] = [];
let currentBuffer: Float32Array | null = null;
let currentBufferCount = 0;
let rendererPort: MessagePort | null = null;

function getBuffer(): Float32Array {
	const ab = freePool.pop();
	if (ab) {
		return new Float32Array(ab);
	}
	return new Float32Array(BUFFER_SIZE);
}

function flushBuffer() {
	if (currentBufferCount > 0 && rendererPort && currentBuffer) {
		const count = currentBufferCount;
		const buf = currentBuffer.buffer;

		rendererPort.postMessage(
			{ type: "PEAKS_UPDATE", payload: { buffer: buf, count } },
			[buf],
		);

		currentBuffer = null;
		currentBufferCount = 0;
	}
}

function pushPeak(progress: number, min: number, max: number) {
	if (!currentBuffer) {
		currentBuffer = getBuffer();
		currentBufferCount = 0;
	}

	currentBuffer[currentBufferCount++] = progress;
	currentBuffer[currentBufferCount++] = min;
	currentBuffer[currentBufferCount++] = max;

	if (currentBufferCount >= BUFFER_SIZE) {
		flushBuffer();
	}
}

function getLastErrorMsg(): string {
	if (!ffmpegModule) return "Wasm module not loaded";

	const err = ffmpegModule.UTF8ToString(ffmpegModule._wasm_get_last_error());

	if (!err) return "Unknown FFmpeg error";
	return err;
}

async function initWasm(ffmpegWasmUrl: string): Promise<FFmpegAudioModule> {
	return await createModule({
		locateFile: () => ffmpegWasmUrl,

		js_get_file_size: (_file_id: number): number => {
			return audioData ? audioData.byteLength : audioFile ? audioFile.size : -1;
		},

		js_read_file: (
			_file_id: number,
			offset: number,
			length: number,
			buffer_ptr: number,
		): number => {
			if (!ffmpegModule) return -1;

			if (audioData) {
				const maxRead = Math.min(length, audioData.byteLength - offset);
				if (maxRead <= 0) return 0;

				const slice = audioData.subarray(offset, offset + maxRead);
				ffmpegModule.HEAPU8.set(slice, buffer_ptr);
				return maxRead;
			}

			if (audioFile) {
				try {
					const blobSlice = audioFile.slice(offset, offset + length);
					const buffer = readerSync.readAsArrayBuffer(blobSlice);
					const u8 = new Uint8Array(buffer);
					ffmpegModule.HEAPU8.set(u8, buffer_ptr);
					return u8.length;
				} catch (err) {
					console.error("Chunk read error:", err);
					return -1;
				}
			}

			return -1;
		},
	});
}

const yieldChannel = new MessageChannel();
yieldChannel.port1.onmessage = () => analyzeLoop();

async function analyzeLoop() {
	if (!isAnalyzing || !ffmpegModule || decoderPtr === 0) return;
	const BATCH_FRAMES = 1000;

	let eof = false;

	const expectedTotalSamples = totalDuration * TARGET_SAMPLE_RATE;

	for (let i = 0; i < BATCH_FRAMES; i++) {
		let status = -1;

		try {
			status = ffmpegModule._wasm_decoder_decode_frame(decoderPtr);
		} catch (wasmErr) {
			console.warn(`Crash during frame decode: ${getErrorMessage(wasmErr)}`);
		}

		if (status === 1) {
			const frameSamples =
				ffmpegModule._wasm_decoder_get_frame_samples(decoderPtr);

			if (frameSamples > 0) {
				try {
					await reacquireOpfsAccessHandle();
				} catch {
					console.warn("[Analyzer] reacquire OPFS handle failed, skip write");
				}
			}

			if (opfsAccessHandle && frameSamples > 0) {
				const ptr = ffmpegModule._wasm_decoder_get_channel_ptr(decoderPtr, 0);
				const pcmView = new Float32Array(
					ffmpegModule.wasmMemory.buffer,
					ptr,
					frameSamples,
				);

				if (pcmWriteOffset + frameSamples > WRITE_BUFFER_CAPACITY) {
					const flushData = pcmWriteBuffer.subarray(0, pcmWriteOffset);
					opfsAccessHandle.write(flushData, { at: totalSamples * 4 - flushData.byteLength });
					pcmWriteOffset = 0;
				}

				pcmWriteBuffer.set(pcmView, pcmWriteOffset);
				pcmWriteOffset += frameSamples;
			}

			totalSamples += frameSamples;

			let progress =
				expectedTotalSamples > 0 ? totalSamples / expectedTotalSamples : 0;
			progress = Math.min(progress, 1.0);
			const min = ffmpegModule._wasm_decoder_get_frame_min(decoderPtr);
			const max = ffmpegModule._wasm_decoder_get_frame_max(decoderPtr);

			pushPeak(progress, min, max);
		} else if (status === 0) {
			eof = true;
			break;
		} else {
			const rawErr = getLastErrorMsg();
			console.warn(`Corrupted frame skipped: ${rawErr}`);
		}
	}

	flushBuffer();

	if (!eof) {
		yieldChannel.port2.postMessage(null);
	} else {
		isAnalyzing = false;

		if (rendererPort) {
			rendererPort.postMessage({ type: "PEAKS_FINALIZE" });
		}

		await new Promise((resolve) => setTimeout(resolve, 0));

		let bpmResult: BpmAnalysisResult | null = null;
		let calculationTime = 0;
		let bpmErrorMsg: string | null = null;

		if (opfsAccessHandle) {
			if (pcmWriteOffset > 0) {
				const finalData = pcmWriteBuffer.subarray(0, pcmWriteOffset);
				opfsAccessHandle.write(finalData, {
					at: totalSamples * 4 - finalData.byteLength,
				});
				pcmWriteOffset = 0;
			}

			opfsAccessHandle.flush();

			if (totalSamples > 0) {
				try {
					const wasmInstance = await getBpmWasm();
					const analyzer = new BpmAnalyzer(totalSamples, {
						sampleRate: TARGET_SAMPLE_RATE,
					});

					const uint8View = new Uint8Array(
						wasmInstance.memory.buffer,
						analyzer.byte_ptr,
						analyzer.byte_capacity,
					);

					await reacquireOpfsAccessHandle();

					const bytesRead = opfsAccessHandle.read(uint8View, { at: 0 });
					const samplesRead = Math.floor(bytesRead / 4);

					analyzer.set_length(samplesRead);

					const startTime = performance.now();
					bpmResult = analyzer.analyze();
					calculationTime = performance.now() - startTime;

					analyzer.free();
				} catch (bpmErr) {
					console.error("BPM calculation failed:", bpmErr);
					bpmErrorMsg = getErrorMessage(bpmErr);
				}
			}

			opfsAccessHandle.close();
			opfsAccessHandle = null;
		}

		if (bpmResult) {
			const { bpm, anchorTick, confidence, ticks } = bpmResult;
			self.postMessage({
				type: "ANALYZE_DONE",
				payload: {
					bpmResult: {
						bpm,
						anchorTick,
						confidence,
						ticks,
					},
					calculationTime,
				},
			});
		} else if (bpmErrorMsg) {
			self.postMessage({
				type: "ANALYZE_ERROR",
				payload: { error: bpmErrorMsg },
			});
		} else {
			self.postMessage({ type: "ANALYZE_DONE" });
		}

		ffmpegModule._wasm_decoder_destroy(decoderPtr);
		decoderPtr = 0;
	}
}

self.onmessage = async (e: MessageEvent) => {
	const { type, payload } = e.data;

	if (type === "INIT") {
		const { file, ffmpegWasmUrl, port } = payload;

		if (rendererPort) {
			rendererPort.onmessage = null;
		}
		rendererPort = port;
		if (rendererPort) {
			rendererPort.onmessage = (msg) => {
				if (msg.data.type === "BUFFER_RETURN") {
					if (freePool.length < 2) {
						freePool.push(msg.data.payload);
					}
				}
			};
		}

		if (file.size < THRESHOLD_50MB) {
			const arrayBuffer = await file.arrayBuffer();
			audioData = new Uint8Array(arrayBuffer);
			audioFile = null;
		} else {
			audioFile = file;
			audioData = null;
		}

		try {
			const rootDir = await navigator.storage.getDirectory();
			const fileHandle = await rootDir.getFileHandle("audio_cache.pcm", {
				create: true,
			});

			opfsFileHandle = fileHandle;
			opfsAccessHandle = await acquireOpfsAccessHandle(fileHandle, opfsChannel);
			opfsAccessHandle.truncate(0);
			pcmWriteOffset = 0;

			ffmpegModule = await initWasm(ffmpegWasmUrl);
			decoderPtr = ffmpegModule._wasm_decoder_create(
				1,
				TARGET_SAMPLE_RATE,
				1,
			);

			if (decoderPtr === 0) throw new Error("Failed to create Wasm Decoder");
			ffmpegModule._wasm_decoder_set_compute_peaks(decoderPtr, 1);
			totalDuration = ffmpegModule._wasm_decoder_get_duration(decoderPtr);

			totalSamples = 0;
			isAnalyzing = true;

			analyzeLoop();
		} catch (err) {
			console.error("[Analyzer] Init Failed:", err);

			if (opfsAccessHandle) {
				opfsAccessHandle.close();
				opfsAccessHandle = null;
			}
			opfsFileHandle = null;

			self.postMessage({
				type: "ANALYZE_ERROR",
				payload: { error: getErrorMessage(err) },
			});
		}
	}
};
