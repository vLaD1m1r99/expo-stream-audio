import {
	AudioFormat,
	CommitStrategy,
	type CommittedTranscriptMessage,
	type CommittedTranscriptWithTimestampsMessage,
	type PartialTranscriptMessage,
	type RealtimeConnection,
	RealtimeEvents,
	Scribe,
	type ScribeAuthErrorMessage,
	type ScribeErrorMessage,
	type ScribeQuotaExceededErrorMessage,
} from "@elevenlabs/client";
import {
	type AudioFrameEvent,
	addErrorListener,
	addFrameListener,
	type BufferedAudioSegment,
	clearBufferedSegments,
	getBufferedSegments,
	getStatus,
	requestPermission,
	setBufferingEnabled,
	start,
	stop,
} from "expo-stream-audio";
import { useEffect, useRef, useState } from "react";
import {
	AppState,
	Button,
	PermissionsAndroid,
	Platform,
	SafeAreaView,
	ScrollView,
	Text,
	View,
} from "react-native";

export default function App() {
	const [streamStatusLabel, setStreamStatusLabel] = useState("idle");
	const [lastFrame, setLastFrame] = useState<{
		sampleRate: number;
		length: number;
		timestamp: number;
		level?: number;
	} | null>(null);
	const [logMessage, setLogMessage] = useState<string | null>(null);
	const [partialTranscript, setPartialTranscript] = useState<string>("");
	const [committedTranscripts, setCommittedTranscripts] = useState<string[]>(
		[],
	);
	const [scribeStatus, setScribeStatus] = useState<
		"disconnected" | "connected" | "error"
	>("disconnected");
	const [bufferedSegments, setBufferedSegments] = useState<
		BufferedAudioSegment[]
	>([]);

	const frameCountRef = useRef(0);
	const scribeConnectionRef = useRef<RealtimeConnection | null>(null);
	const scribeReadyRef = useRef(false);
	const stoppedManuallyRef = useRef(false);
	const shouldReconnectRef = useRef(false);
	const isProcessingBufferedRef = useRef(false);
	const appStateRef = useRef(AppState.currentState);

	const frameSubRef = useRef<{ remove: () => void } | null>(null);
	const errorSubRef = useRef<{ remove: () => void } | null>(null);

	useEffect(() => {
		const appStateSubscription = AppState.addEventListener(
			"change",
			(nextState) => {
				const prevState = appStateRef.current;
				appStateRef.current = nextState;

				if (
					(prevState === "background" || prevState === "inactive") &&
					nextState === "active"
				) {
					if (shouldReconnectRef.current) {
						// eslint-disable-next-line no-console
						console.log(
							"App foregrounded, reconnecting Scribe and processing buffered segments",
						);
						void reconnectAndProcessBuffered();
					}
				}
			},
		);

		getStatus()
			.then((status) => setStreamStatusLabel(status))
			.catch(() => setStreamStatusLabel("idle"));

		return () => {
			appStateSubscription.remove();
			frameSubRef.current?.remove();
			errorSubRef.current?.remove();
			const currentConnection = scribeConnectionRef.current;
			if (currentConnection) {
				try {
					currentConnection.close();
				} catch {
					// ignore
				}
				scribeConnectionRef.current = null;
				scribeReadyRef.current = false;
			}
			stop().catch((error) => {
				console.warn("Failed to stop mic stream on cleanup", error);
			});
		};
	}, []);

	// WARNING: only use this in local testing.
	// Do NOT commit a real API key.
	const ELEVENLABS_API_KEY =
		"sk_1e09f32c548e384d6f104b28e03caa3b770e2601b7c35022";

	const fetchScribeToken = async (): Promise<string> => {
		if (!ELEVENLABS_API_KEY) {
			throw new Error("Set ELEVENLABS_API_KEY in App.tsx before testing.");
		}

		const response = await fetch(
			"https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
			{
				method: "POST",
				headers: {
					"xi-api-key": ELEVENLABS_API_KEY,
					"Content-Type": "application/json",
				},
			},
		);

		const json = (await response.json()) as { token?: string; error?: string };

		if (!response.ok) {
			throw new Error(
				json.error || `Failed to fetch Scribe token: ${response.status}`,
			);
		}

		if (!json.token) {
			throw new Error("Scribe token missing in response payload");
		}

		return json.token;
	};

	const attachScribeListeners = (connection: RealtimeConnection) => {
		connection.on(RealtimeEvents.OPEN, () => {
			// eslint-disable-next-line no-console
			console.log("Scribe OPEN");
			scribeReadyRef.current = true;
			setScribeStatus("connected");
		});

		connection.on(RealtimeEvents.SESSION_STARTED, () => {
			// eslint-disable-next-line no-console
			console.log("Scribe SESSION_STARTED");
			scribeReadyRef.current = true;
			setScribeStatus("connected");
		});

		connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (...args: unknown[]) => {
			const [data] = args as [PartialTranscriptMessage];
			if (!data?.text) {
				return;
			}
			// eslint-disable-next-line no-console
			console.log("Scribe PARTIAL", data);
			setPartialTranscript(data.text);
			setScribeStatus("connected");
		});

		connection.on(
			RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS,
			(...args: unknown[]) => {
				const [data] = args as [CommittedTranscriptWithTimestampsMessage];
				if (!data?.text) {
					return;
				}
				// eslint-disable-next-line no-console
				console.log("Scribe COMMITTED_WITH_TIMESTAMPS", data);
				setCommittedTranscripts((prev) => [...prev, data.text ?? ""]);
				setPartialTranscript("");
				setScribeStatus("connected");
			},
		);

		connection.on(RealtimeEvents.ERROR, (...args: unknown[]) => {
			const [data] = args as [ScribeErrorMessage];
			const message = data?.error ?? "Scribe error";
			if (stoppedManuallyRef.current) {
				// Ignore errors emitted as part of an intentional shutdown.
				return;
			}
			// eslint-disable-next-line no-console
			console.error("Scribe ERROR", message);
			setLogMessage(message);
			setScribeStatus("error");
		});

		connection.on(RealtimeEvents.AUTH_ERROR, (...args: unknown[]) => {
			const [data] = args as [ScribeAuthErrorMessage];
			const message = data?.error ?? "Scribe auth error";
			// eslint-disable-next-line no-console
			console.error("Scribe AUTH_ERROR", message);
			setLogMessage(message);
			setScribeStatus("error");
		});

		connection.on(RealtimeEvents.QUOTA_EXCEEDED, (...args: unknown[]) => {
			const [data] = args as [ScribeQuotaExceededErrorMessage];
			const message = data?.error ?? "Scribe quota exceeded";
			// eslint-disable-next-line no-console
			console.error("Scribe QUOTA_EXCEEDED", message);
			setLogMessage(message);
			setScribeStatus("error");
		});

		connection.on(RealtimeEvents.CLOSE, (...args: unknown[]) => {
			const [event] = args as [unknown];
			// eslint-disable-next-line no-console
			console.log("Scribe CLOSE", event);
			scribeReadyRef.current = false;
			if (stoppedManuallyRef.current) {
				setScribeStatus("disconnected");
				shouldReconnectRef.current = false;
			} else {
				setScribeStatus("disconnected");
				shouldReconnectRef.current = true;
				// Enable native buffering for the period where realtime is unavailable.
				setBufferingEnabled(true).catch((error) => {
					// eslint-disable-next-line no-console
					console.error("Failed to enable buffering", error);
				});
				setLogMessage(
					"Scribe disconnected; buffering audio and will reconnect/process buffered when app is active.",
				);
			}
		});
	};

	const createScribeConnection = async () => {
		if (scribeConnectionRef.current) {
			try {
				scribeConnectionRef.current.close();
			} catch {
				// ignore
			}
			scribeConnectionRef.current = null;
			scribeReadyRef.current = false;
		}

		const token = await fetchScribeToken();

		const connection = Scribe.connect({
			token,
			modelId: "scribe_v2_realtime",
			audioFormat: AudioFormat.PCM_16000,
			sampleRate: 16000,
			commitStrategy: CommitStrategy.VAD,
			vadSilenceThresholdSecs: 0.5,
			vadThreshold: 0.35,
			minSpeechDurationMs: 120,
			minSilenceDurationMs: 90,
			includeTimestamps: true,
		});

		scribeConnectionRef.current = connection;
		scribeReadyRef.current = false;

		attachScribeListeners(connection);
	};

	const handleFrame = (event: AudioFrameEvent) => {
		frameCountRef.current += 1;

		setLastFrame({
			sampleRate: event.sampleRate,
			length: event.pcmBase64.length,
			timestamp: event.timestamp,
			level: event.level,
		});

		if (frameCountRef.current % 50 === 0) {
			// eslint-disable-next-line no-console
			console.log("Mic frame", {
				index: frameCountRef.current,
				timestamp: event.timestamp,
				level: event.level,
			});
		}

		const connection = scribeConnectionRef.current;
		if (connection && scribeReadyRef.current) {
			try {
				connection.send({
					audioBase64: event.pcmBase64,
					sampleRate: event.sampleRate,
				});
			} catch (error) {
				// eslint-disable-next-line no-console
				console.error("Failed to send audio to Scribe", error);
			}
		}
	};

	const handleStart = async () => {
		stoppedManuallyRef.current = false;
		shouldReconnectRef.current = false;
		setLogMessage(null);

		let permission = await requestPermission();

		if (Platform.OS === "android" && permission !== "granted") {
			try {
				const result = await PermissionsAndroid.request(
					PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
				);
				if (result === PermissionsAndroid.RESULTS.GRANTED) {
					permission = "granted";
				} else {
					setLogMessage("Android microphone permission denied.");
					return;
				}
			} catch (error) {
				setLogMessage(
					`Failed to request Android mic permission: ${(error as Error)?.message ?? "Unknown error"}`,
				);
				return;
			}
		}

		if (Platform.OS === "ios" && permission === "undetermined") {
			permission = "granted";
		}

		if (permission !== "granted") {
			setLogMessage(`Microphone permission not granted: ${permission}`);
			return;
		}

		// Reset Scribe state
		setPartialTranscript("");
		setCommittedTranscripts([]);

		frameSubRef.current?.remove();
		errorSubRef.current?.remove();

		frameSubRef.current = addFrameListener(handleFrame);
		errorSubRef.current = addErrorListener((event) => {
			setLogMessage(event.message);
		});

		try {
			await createScribeConnection();

			await start({
				sampleRate: 16000,
				frameDurationMs: 20,
				enableLevelMeter: true,
				enableBackground: true,
				// Buffering will be enabled on-demand when Scribe disconnects unexpectedly.
				enableBuffering: false,
				bufferChunkSeconds: 300,
				maxBufferedMinutes: 60,
			});

			setStreamStatusLabel("recording");
			setScribeStatus("connected");
		} catch (error) {
			setLogMessage(
				`Failed to start stream: ${(error as Error)?.message ?? "Unknown error"}`,
			);
			return;
		}
	};

	const handleStop = async () => {
		stoppedManuallyRef.current = true;
		shouldReconnectRef.current = false;
		isProcessingBufferedRef.current = false;

		frameSubRef.current?.remove();
		errorSubRef.current?.remove();

		const currentConnection = scribeConnectionRef.current;
		if (currentConnection) {
			try {
				currentConnection.close();
			} catch {
				// ignore
			}
			scribeConnectionRef.current = null;
			scribeReadyRef.current = false;
		}

		// Ensure native stops buffering as well.
		try {
			await setBufferingEnabled(false);
		} catch {
			// ignore
		}

		try {
			await stop();
		} catch (error) {
			setLogMessage(
				`Failed to stop stream: ${(error as Error)?.message ?? "Unknown error"}`,
			);
		}

		const status = await getStatus().catch(() => "idle");
		setStreamStatusLabel(status);
		setScribeStatus("disconnected");
	};

	const transcribeBufferedSegment = async (
		segment: BufferedAudioSegment,
	): Promise<string | null> => {
		if (!ELEVENLABS_API_KEY) {
			throw new Error(
				"Set ELEVENLABS_API_KEY in App.tsx before testing buffered transcription.",
			);
		}

		// NOTE: Endpoint and response shape may need adjustment
		// according to the latest ElevenLabs STT docs.
		const form = new FormData();
		form.append("file", {
			// React Native understands file uploads via `uri`
			uri: segment.uri,
			name: `segment-${segment.id}.wav`,
			type: "audio/wav",
		} as unknown as Blob);
		form.append("model_id", "scribe_v2"); // Adjust if ElevenLabs uses a different identifier

		const response = await fetch(
			"https://api.elevenlabs.io/v1/speech-to-text",
			{
				method: "POST",
				headers: {
					"xi-api-key": ELEVENLABS_API_KEY,
				},
				body: form,
			},
		);

		const json = (await response.json()) as { text?: string; error?: string };

		if (!response.ok) {
			const message = json.error || `Buffered STT failed: ${response.status}`;
			throw new Error(message);
		}

		if (!json.text) {
			return null;
		}

		return json.text;
	};

	const refreshBufferedSegments = async () => {
		try {
			const segments = await getBufferedSegments();
			setBufferedSegments(segments);
		} catch (error) {
			setLogMessage(
				`Failed to load buffered segments: ${(error as Error)?.message ?? "Unknown error"}`,
			);
		}
	};

	const processBufferedSegments = async () => {
		if (isProcessingBufferedRef.current) {
			return;
		}
		isProcessingBufferedRef.current = true;

		try {
			const segments = await getBufferedSegments();
			setBufferedSegments(segments);

			if (!segments.length) {
				return;
			}

			for (const segment of segments) {
				try {
					// eslint-disable-next-line no-console
					console.log("Processing buffered segment", segment);
					const text = await transcribeBufferedSegment(segment);
					if (text && text.length > 0) {
						setCommittedTranscripts((prev) => [...prev, text]);
					}
				} catch (error) {
					// eslint-disable-next-line no-console
					console.error(
						"Failed to transcribe buffered segment",
						segment.id,
						error,
					);
					setLogMessage(
						`Failed buffered segment ${segment.id}: ${(error as Error)?.message ?? "Unknown error"}`,
					);
				}
			}

			await clearBufferedSegments();
			setBufferedSegments([]);
		} catch (error) {
			setLogMessage(
				`Failed to process buffered segments: ${(error as Error)?.message ?? "Unknown error"}`,
			);
		} finally {
			isProcessingBufferedRef.current = false;
		}
	};

	const reconnectAndProcessBuffered = async () => {
		try {
			await createScribeConnection();
			setScribeStatus("connected");
			await processBufferedSegments();
			await setBufferingEnabled(false);
		} catch (error) {
			setLogMessage(
				`Failed to reconnect/process buffered: ${(error as Error)?.message ?? "Unknown error"}`,
			);
		} finally {
			shouldReconnectRef.current = false;
		}
	};

	return (
		<SafeAreaView style={styles.container}>
			<ScrollView style={styles.container}>
				<Text style={styles.header}>expo-stream-audio: Mic Stream Test</Text>

				<Group name="Controls">
					<Text style={styles.label}>Status: {streamStatusLabel}</Text>
					{streamStatusLabel === "recording" ? (
						<Button title="Stop stream" onPress={handleStop} />
					) : (
						<Button title="Start stream" onPress={handleStart} />
					)}
				</Group>

				<Group name="Last frame">
					{lastFrame ? (
						<>
							<Text>Sample rate: {lastFrame.sampleRate} Hz</Text>
							<Text>Base64 length: {lastFrame.length}</Text>
							<Text>
								Timestamp: {new Date(lastFrame.timestamp).toLocaleTimeString()}
							</Text>
							{typeof lastFrame.level === "number" ? (
								<Text>Level (RMS): {lastFrame.level.toFixed(6)}</Text>
							) : null}
						</>
					) : (
						<Text>No frames yet. Press “Start stream”.</Text>
					)}
				</Group>

				<Group name="Scribe transcript">
					<Text>Status: {scribeStatus}</Text>
					<View style={styles.transcriptContainer}>
						<ScrollView nestedScrollEnabled>
							{partialTranscript ? (
								<Text>Live: {partialTranscript}</Text>
							) : (
								<Text>No partial transcript yet.</Text>
							)}
							{committedTranscripts.length > 0 ? (
								<>
									<Text>Committed:</Text>
									{committedTranscripts.map((text, idx) => (
										<Text key={`${idx}-${text}`}>{text}</Text>
									))}
								</>
							) : null}
						</ScrollView>
					</View>
				</Group>

				<Group name="Buffered segments">
					<Button
						title="Refresh buffered segments"
						onPress={refreshBufferedSegments}
					/>
					<Button
						title="Process buffered segments now"
						onPress={processBufferedSegments}
					/>
					{bufferedSegments.length > 0 ? (
						<>
							<Text>Buffered count: {bufferedSegments.length}</Text>
							{bufferedSegments.map((segment) => (
								<Text key={segment.id}>
									{new Date(segment.startTimestamp).toLocaleTimeString()} –{" "}
									{Math.round(segment.durationMs / 1000)}s –{" "}
									{Math.round(segment.sizeBytes / 1024)} KB
								</Text>
							))}
						</>
					) : (
						<Text>No buffered segments.</Text>
					)}
				</Group>

				<Group name="Log">
					<Text>{logMessage ?? "No errors."}</Text>
				</Group>
			</ScrollView>
		</SafeAreaView>
	);
}

function Group(props: { name: string; children: React.ReactNode }) {
	return (
		<View style={styles.group}>
			<Text style={styles.groupHeader}>{props.name}</Text>
			<View style={styles.groupBody}>{props.children}</View>
		</View>
	);
}

const styles = {
	header: {
		fontSize: 30,
		margin: 20,
	},
	groupHeader: {
		fontSize: 20,
		marginBottom: 20,
	},
	group: {
		margin: 20,
		backgroundColor: "#fff",
		borderRadius: 10,
		padding: 20,
	},
	groupBody: {
		gap: 8,
	},
	transcriptContainer: {
		maxHeight: 200,
		borderWidth: 1,
		borderColor: "#ddd",
		borderRadius: 8,
		padding: 8,
	},
	container: {
		flex: 1,
		backgroundColor: "#eee",
	},
	label: {
		marginBottom: 8,
	},
};
