import {
	AudioFormat,
	CommitStrategy,
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
	ActivityIndicator,
	Animated,
	AppState,
	Dimensions,
	PermissionsAndroid,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";

import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
	const [first] = args;
	if (
		typeof first === "string" &&
		first.startsWith("WebSocket closed unexpectedly: 1000")
	) {
		// Swallow noisy clean-close logs from the WebSocket layer.
		return;
	}
	// Forward all other errors to the original console for debug tooling.
	originalConsoleError(...args);
};

declare const process: {
	env?: Record<string, string | undefined>;
};

type Tab = "realtime" | "transcript" | "debug";

type CommittedSegment = {
	id: string;
	text: string;
	speakerId?: string;
	startSeconds?: number;
};

const { height: WINDOW_HEIGHT } = Dimensions.get("window");
const TRANSCRIPT_HEIGHT = Math.round(WINDOW_HEIGHT * 0.5);

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
	const [committedTranscripts, setCommittedTranscripts] = useState<
		CommittedSegment[]
	>([]);
	const [scribeStatus, setScribeStatus] = useState<
		"disconnected" | "connected" | "error"
	>("disconnected");
	const [isStarting, setIsStarting] = useState(false);
	const [activeTab, setActiveTab] = useState<Tab>("realtime");

	const frameCountRef = useRef(0);
	const scribeConnectionRef = useRef<RealtimeConnection | null>(null);
	const scribeReadyRef = useRef(false);
	const stoppedManuallyRef = useRef(false);
	const shouldReconnectRef = useRef(false);
	const isProcessingBufferedRef = useRef(false);
	const appStateRef = useRef(AppState.currentState);
	const transcriptScrollRef = useRef<ScrollView | null>(null);

	const frameSubRef = useRef<{ remove: () => void } | null>(null);
	const errorSubRef = useRef<{ remove: () => void } | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectAndProcessBuffered uses refs only and is safe here.
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
			stop().catch(() => {});
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: this effect intentionally runs when transcript content changes to auto-scroll.
	useEffect(() => {
		if (transcriptScrollRef.current) {
			transcriptScrollRef.current.scrollToEnd({ animated: true });
		}
	}, [committedTranscripts.length, partialTranscript]);

	// WARNING: only use this in local testing.
	// Do NOT commit a real API key.
	// Prefer an EXPO_PUBLIC_ELEVENLABS_API_KEY environment variable when available.
	// For local testing you can also hard‑code a test key here, but NEVER commit a real key.
	const ELEVENLABS_API_KEY = process.env?.EXPO_PUBLIC_ELEVENLABS_API_KEY ?? "";
	const hasApiKey = !!ELEVENLABS_API_KEY;

	const fetchScribeToken = async (): Promise<string> => {
		if (!ELEVENLABS_API_KEY) {
			throw new Error(
				"Set EXPO_PUBLIC_ELEVENLABS_API_KEY (see .env.example) before testing.",
			);
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
			scribeReadyRef.current = true;
			setScribeStatus("connected");
		});

		connection.on(RealtimeEvents.SESSION_STARTED, () => {
			scribeReadyRef.current = true;
			setScribeStatus("connected");
		});

		connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (...args: unknown[]) => {
			const [data] = args as [PartialTranscriptMessage];
			if (!data?.text) {
				return;
			}
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
				const firstWordWithStart =
					data.words?.find(
						(word) => word.type === "word" && typeof word.start === "number",
					) ?? null;
				const firstWordWithSpeaker =
					data.words?.find(
						(word) =>
							word.type === "word" && typeof word.speaker_id === "string",
					) ?? null;
				const segment: CommittedSegment = {
					id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					text: data.text ?? "",
					speakerId: firstWordWithSpeaker?.speaker_id,
					startSeconds:
						typeof firstWordWithStart?.start === "number"
							? firstWordWithStart.start
							: undefined,
				};
				setCommittedTranscripts((prev) => [...prev, segment]);
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

			// Treat clean WebSocket closes (code 1000) as a normal disconnect,
			// not as a hard error.
			if (
				typeof message === "string" &&
				message.includes("WebSocket closed unexpectedly") &&
				message.includes("1000")
			) {
				setScribeStatus("disconnected");
				return;
			}

			// Some SDK versions emit a generic "Scribe error" message after a clean close.
			// Treat that as non-fatal so it doesn't surface as an error in the UI.
			if (message === "Scribe error") {
				return;
			}

			setLogMessage(message);
			setScribeStatus("error");
		});

		connection.on(RealtimeEvents.AUTH_ERROR, (...args: unknown[]) => {
			const [data] = args as [ScribeAuthErrorMessage];
			const message = data?.error ?? "Scribe auth error";
			setLogMessage(message);
			setScribeStatus("error");
		});

		connection.on(RealtimeEvents.QUOTA_EXCEEDED, (...args: unknown[]) => {
			const [data] = args as [ScribeQuotaExceededErrorMessage];
			const message = data?.error ?? "Scribe quota exceeded";
			setLogMessage(message);
			setScribeStatus("error");
		});

		connection.on(RealtimeEvents.CLOSE, (...args: unknown[]) => {
			const [event] = args as [unknown];
			const closeEvent = event as
				| { code?: number; reason?: string; wasClean?: boolean }
				| undefined;
			scribeReadyRef.current = false;

			// Treat clean 1000 close as an informational disconnect, not an error.
			if (closeEvent?.code === 1000) {
				setScribeStatus("disconnected");
				shouldReconnectRef.current = false;
				if (!stoppedManuallyRef.current) {
					setLogMessage("Scribe connection closed cleanly.");
				}
				return;
			}

			if (stoppedManuallyRef.current) {
				setScribeStatus("disconnected");
				shouldReconnectRef.current = false;
			} else {
				setScribeStatus("disconnected");
				shouldReconnectRef.current = true;
				// Enable native buffering for the period where realtime is unavailable.
				setBufferingEnabled(true).catch((error) => {
					setLogMessage(
						`Failed to enable buffering: ${(error as Error)?.message ?? "Unknown error"}`,
					);
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
			// Use Scribe's default VAD tuning, but still rely on VAD-based commits.
			commitStrategy: CommitStrategy.VAD,
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

		const connection = scribeConnectionRef.current;
		if (connection && scribeReadyRef.current) {
			try {
				connection.send({
					audioBase64: event.pcmBase64,
					sampleRate: event.sampleRate,
				});
			} catch {
				// ignore send errors; they'll be surfaced via Scribe events if needed
			}
		}
	};

	const handleStart = async () => {
		if (isStarting) {
			return;
		}

		if (!ELEVENLABS_API_KEY) {
			setLogMessage(
				"Set EXPO_PUBLIC_ELEVENLABS_API_KEY (see .env.example) before starting Scribe realtime.",
			);
			return;
		}

		stoppedManuallyRef.current = false;
		shouldReconnectRef.current = false;
		setLogMessage(null);

		setIsStarting(true);

		try {
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
			setActiveTab("transcript");
		} catch (error) {
			setLogMessage(
				`Failed to start stream: ${(error as Error)?.message ?? "Unknown error"}`,
			);
		} finally {
			setIsStarting(false);
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
		bufferSegment: BufferedAudioSegment,
	): Promise<string | null> => {
		if (!ELEVENLABS_API_KEY) {
			throw new Error(
				"Set EXPO_PUBLIC_ELEVENLABS_API_KEY (see .env.example) before testing buffered transcription.",
			);
		}

		// NOTE: Endpoint and response shape may need adjustment
		// according to the latest ElevenLabs STT docs.
		const form = new FormData();
		form.append("file", {
			// React Native understands file uploads via `uri`
			uri: bufferSegment.uri,
			name: `segment-${bufferSegment.id}.wav`,
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

	const processBufferedSegments = async () => {
		if (!ELEVENLABS_API_KEY) {
			setLogMessage(
				"Set EXPO_PUBLIC_ELEVENLABS_API_KEY (see .env.example) before processing buffered segments.",
			);
			return;
		}

		if (isProcessingBufferedRef.current) {
			return;
		}
		isProcessingBufferedRef.current = true;

		try {
			const segments = await getBufferedSegments();

			if (!segments.length) {
				return;
			}

			for (const segment of segments) {
				try {
					const text = await transcribeBufferedSegment(segment);
					if (text && text.length > 0) {
						const committed: CommittedSegment = {
							id: `buffered-${segment.id}-${Date.now()}`,
							text,
						};
						setCommittedTranscripts((prev) => [...prev, committed]);
					}
				} catch (error) {
					setLogMessage(
						`Failed buffered segment ${segment.id}: ${(error as Error)?.message ?? "Unknown error"}`,
					);
				}
			}

			await clearBufferedSegments();
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
		<SafeAreaProvider>
			<SafeAreaView style={styles.container}>
				<ScrollView style={styles.container}>
				<Text style={styles.header}>Stream Audio Demo App</Text>
				<Text style={styles.subheader}>
					expo-stream-audio + ElevenLabs Scribe v2 Realtime
				</Text>

				<View style={styles.tabBar}>
					<TabButton
						label="Realtime"
						isActive={activeTab === "realtime"}
						onPress={() => setActiveTab("realtime")}
					/>
					<TabButton
						label="Transcript"
						isActive={activeTab === "transcript"}
						onPress={() => setActiveTab("transcript")}
					/>
					<TabButton
						label="Debug"
						isActive={activeTab === "debug"}
						onPress={() => setActiveTab("debug")}
					/>
				</View>

				{activeTab === "realtime" && (
					<>
						<Group name={hasApiKey ? "Setup complete" : "Setup"}>
							{hasApiKey ? (
								<View style={styles.setupSuccessRow}>
									<Text style={styles.successIcon}>✓</Text>
									<Text style={styles.successText}>API key detected</Text>
								</View>
							) : (
								<>
									<Text style={styles.label}>
										To test Scribe, copy{" "}
										<Text style={styles.code}>.env.example</Text> to{" "}
										<Text style={styles.code}>.env</Text> and set{" "}
										<Text style={styles.code}>
											EXPO_PUBLIC_ELEVENLABS_API_KEY
										</Text>{" "}
										to your ElevenLabs API key. For local testing you can also
										hard‑code a key in <Text style={styles.code}>App.tsx</Text>,
										but never commit a real key.
									</Text>
									<Text style={styles.warningText}>
										Realtime transcription is disabled until you set an API key.
									</Text>
								</>
							)}
						</Group>

						<Group name="Realtime controls">
							<View style={styles.statusRow}>
								<Text style={styles.statusLabel}>Mic</Text>
								<Text style={styles.statusColon}>:</Text>
								<StatusBadge
									label={streamStatusLabel}
									tone={streamStatusLabel === "recording" ? "ok" : "idle"}
								/>

								<View style={styles.statusSpacer} />

								<Text style={styles.statusLabel}>Scribe</Text>
								<Text style={styles.statusColon}>:</Text>
								<StatusBadge
									label={scribeStatus}
									tone={
										scribeStatus === "connected"
											? "ok"
											: scribeStatus === "error"
												? "error"
												: "idle"
									}
								/>
							</View>

							{streamStatusLabel === "recording" ? (
								<PrimaryButton
									title="Stop Stream"
									onPress={handleStop}
									disabled={isStarting}
								/>
							) : (
								<PrimaryButton
									title="Start Stream"
									onPress={handleStart}
									disabled={!hasApiKey || isStarting}
									loading={isStarting}
								/>
							)}
						</Group>
					</>
				)}

				{activeTab === "transcript" && (
					<>
						<LiveIndicator
							isLive={
								streamStatusLabel === "recording" &&
								scribeStatus === "connected"
							}
						/>
						<Group name="">
							<View style={styles.transcriptContainer}>
								{committedTranscripts.length === 0 &&
								!partialTranscript &&
								streamStatusLabel !== "recording" ? (
									<View style={styles.emptyTranscript}>
										<Text style={[styles.mutedLabel, styles.emptyTranscriptText]}>
											Start the stream to see the live transcript.
										</Text>
										<PrimaryButton
											title="Start Stream"
											onPress={handleStart}
											disabled={!hasApiKey || isStarting}
											loading={isStarting}
										/>
									</View>
								) : (
									<ScrollView nestedScrollEnabled ref={transcriptScrollRef}>
										{committedTranscripts.map((segment) => (
											<View key={segment.id} style={styles.segmentRow}>
												<View style={styles.segmentLine}>
													{segment.startSeconds != null && (
														<Text style={styles.segmentMeta}>
															{formatSeconds(segment.startSeconds)}
														</Text>
													)}
													{segment.speakerId != null && (
														<Text style={styles.segmentSpeaker}>
															{formatSpeaker(segment.speakerId)}
														</Text>
													)}
													<Text style={styles.segmentText}>
														{segment.text}
													</Text>
												</View>
											</View>
										))}

										{partialTranscript ? (
											<View style={styles.segmentRow}>
												<View style={styles.segmentLine}>
													<Text style={styles.segmentTextPartial}>
														{partialTranscript}
													</Text>
												</View>
											</View>
										) : streamStatusLabel === "recording" ? (
											<Text style={styles.segmentTextPartial}>Listening…</Text>
										) : null}
									</ScrollView>
								)}
							</View>
						</Group>
					</>
				)}

				{activeTab === "debug" && (
					<>
						<Group name="Mic debug">
							{lastFrame ? (
								<>
									<Text>Sample rate: {lastFrame.sampleRate} Hz</Text>
									<Text>
										Timestamp:{" "}
										{new Date(lastFrame.timestamp).toLocaleTimeString()}
									</Text>
									{typeof lastFrame.level === "number" ? (
										<LevelMeter level={lastFrame.level} />
									) : null}
								</>
							) : (
								<Text style={styles.mutedLabel}>
									No frames yet. Press “Start stream”.
								</Text>
							)}
						</Group>

						<Group name="Log">
							<Text>{logMessage ?? "No errors."}</Text>
						</Group>

						<Group name="Buffered audio behavior">
							<Text style={styles.mutedLabel}>
								When Scribe disconnects unexpectedly, audio is buffered natively
								as WAV files and processed when a connection is available again.
							</Text>
						</Group>
					</>
				)}
				</ScrollView>
			</SafeAreaView>
		</SafeAreaProvider>
	);
}

function Group(props: { name: string; children: React.ReactNode }) {
	return (
		<View style={styles.group}>
			{props.name ? <Text style={styles.groupHeader}>{props.name}</Text> : null}
			<View style={styles.groupBody}>{props.children}</View>
		</View>
	);
}

function TabButton(props: {
	label: string;
	isActive: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable
			onPress={props.onPress}
			style={[styles.tabButton, props.isActive ? styles.tabButtonActive : null]}
		>
			<Text
				style={[
					styles.tabButtonLabel,
					props.isActive ? styles.tabButtonLabelActive : null,
				]}
			>
				{props.label}
			</Text>
		</Pressable>
	);
}

function StatusBadge(props: { label: string; tone: "idle" | "ok" | "error" }) {
	const toneStyle =
		props.tone === "ok"
			? styles.statusBadgeOk
			: props.tone === "error"
				? styles.statusBadgeError
				: styles.statusBadgeIdle;

	return (
		<View style={[styles.statusBadge, toneStyle]}>
			<Text style={styles.statusBadgeText}>{props.label}</Text>
		</View>
	);
}

function PrimaryButton(props: {
	title: string;
	onPress: () => void;
	disabled?: boolean;
	loading?: boolean;
}) {
	const isDisabled = props.disabled || props.loading;
	return (
		<Pressable
			onPress={props.onPress}
			disabled={isDisabled}
			style={[
				styles.primaryButton,
				isDisabled ? styles.primaryButtonDisabled : null,
			]}
		>
			{props.loading ? (
				<ActivityIndicator color="#f9fafb" />
			) : (
				<Text style={styles.primaryButtonText}>{props.title}</Text>
			)}
		</Pressable>
	);
}

function LiveIndicator(props: { isLive: boolean }) {
	const scale = useRef(new Animated.Value(1)).current;

	useEffect(() => {
		let loop: Animated.CompositeAnimation | null = null;

		if (props.isLive) {
			loop = Animated.loop(
				Animated.sequence([
					Animated.timing(scale, {
						toValue: 1.3,
						duration: 600,
						useNativeDriver: true,
					}),
					Animated.timing(scale, {
						toValue: 1,
						duration: 600,
						useNativeDriver: true,
					}),
				]),
			);
			loop.start();
		} else {
			scale.setValue(1);
		}

		return () => {
			if (loop) {
				loop.stop();
			}
		};
	}, [props.isLive, scale]);

	const dotTone = props.isLive ? styles.liveDotOn : styles.liveDotOff;
	const textStyle = props.isLive ? styles.liveTextOn : styles.liveTextOff;
	const label = props.isLive ? "Streaming live" : "Not streaming";

	return (
		<View style={styles.liveRow}>
			<Animated.View
				style={[styles.liveDot, dotTone, { transform: [{ scale }] }]}
			/>
			<Text style={textStyle}>{label}</Text>
		</View>
	);
}

function formatSeconds(value: number): string {
	const total = Math.max(0, Math.floor(value));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes.toString().padStart(2, "0")}:${seconds
		.toString()
		.padStart(2, "0")}`;
}

function formatSpeaker(rawId: string): string {
	const short = rawId.length > 8 ? rawId.slice(0, 8) : rawId;
	return `Speaker ${short}`;
}

function LevelMeter(props: { level: number }) {
	// Scale RMS (usually very small) to a more readable 0–100% range.
	const clamped = Math.max(0, Math.min(props.level, 1));
	const scaled = Math.min(clamped * 10, 1); // 10x boost, capped at 100%
	const percent = Math.round(scaled * 100);

	return (
		<View style={styles.levelCard}>
			<Text style={styles.mutedLabel}>RMS level</Text>
			<View style={styles.levelBarBackground}>
				<View style={[styles.levelBarFill, { width: `${percent}%` }]} />
			</View>
			<Text style={styles.levelPercent}>{percent}%</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	header: {
		fontSize: 30,
		marginTop: 32,
		marginHorizontal: 20,
		marginBottom: 6,
		textAlign: "center",
	},
	subheader: {
		marginHorizontal: 24,
		marginBottom: 20,
		color: "#6b7280",
		textAlign: "center",
	},
	groupHeader: {
		fontSize: 20,
		marginBottom: 20,
	},
	group: {
		marginHorizontal: 20,
		marginVertical: 10,
		backgroundColor: "#fff",
		borderRadius: 10,
		padding: 12,
	},
	groupBody: {
		// simple vertical spacing; adjust via margins as needed
	},
	transcriptContainer: {
		height: TRANSCRIPT_HEIGHT,
	},
	container: {
		flex: 1,
		backgroundColor: "#eee",
	},
	label: {
		marginBottom: 8,
	},
	statusLabel: {
		marginBottom: 0,
		fontWeight: "600",
		color: "#111827",
	},
	statusColon: {
		marginHorizontal: 4,
		color: "#6b7280",
	},
	statusSpacer: {
		width: 16,
	},
	mutedLabel: {
		color: "#6b7280",
	},
	warningText: {
		color: "#b91c1c",
	},
	successText: {
		color: "#15803d",
	},
	setupSuccessRow: {
		flexDirection: "row",
		alignItems: "center",
	},
	successIcon: {
		marginRight: 6,
		color: "#15803d",
	},
	primaryButton: {
		marginTop: 8,
		borderRadius: 999,
		backgroundColor: "#111827",
		paddingVertical: 10,
		alignItems: "center",
		alignSelf: "stretch",
	},
	primaryButtonDisabled: {
		opacity: 0.5,
	},
	primaryButtonText: {
		color: "#f9fafb",
		fontWeight: "600",
		fontSize: 16,
	},
	code: {
		fontFamily: "Menlo",
	},
	tabBar: {
		flexDirection: "row",
		marginHorizontal: 20,
		marginBottom: 12,
		backgroundColor: "#e5e7eb",
		borderRadius: 999,
		padding: 4,
	},
	tabButton: {
		flex: 1,
		alignItems: "center",
		paddingVertical: 8,
		borderRadius: 999,
	},
	tabButtonActive: {
		backgroundColor: "#111827",
	},
	tabButtonLabel: {
		fontSize: 14,
		fontWeight: "600",
		color: "#4b5563",
	},
	tabButtonLabelActive: {
		color: "#f9fafb",
	},
	statusRow: {
		flexDirection: "row",
		alignItems: "center",
		marginBottom: 12,
	},
	statusBadge: {
		borderRadius: 999,
		paddingHorizontal: 8,
		paddingVertical: 2,
	},
	statusBadgeIdle: {
		backgroundColor: "#e5e7eb",
	},
	statusBadgeOk: {
		backgroundColor: "#bbf7d0",
	},
	statusBadgeError: {
		backgroundColor: "#fecaca",
	},
	statusBadgeText: {
		fontSize: 12,
		fontWeight: "500",
		color: "#111827",
	},
	segmentRow: {
		marginBottom: 8,
	},
	segmentLine: {
		flexDirection: "row",
		alignItems: "baseline",
	},
	segmentMeta: {
		fontSize: 11,
		color: "#6b7280",
		marginRight: 8,
		minWidth: 52,
	},
	segmentSpeaker: {
		fontSize: 11,
		color: "#6b7280",
		marginRight: 8,
	},
	segmentText: {
		fontSize: 14,
		color: "#111827",
		flexShrink: 1,
	},
	segmentTextPartial: {
		fontSize: 14,
		color: "#6b7280",
		fontStyle: "italic",
	},
	emptyTranscript: {
		flex: 1,
		alignItems: "stretch",
		justifyContent: "center",
		gap: 8,
	},
	emptyTranscriptText: {
		textAlign: "center",
	},
	levelCard: {
		marginTop: 8,
	},
	levelBarBackground: {
		marginTop: 4,
		height: 8,
		borderRadius: 4,
		backgroundColor: "#e5e7eb",
		overflow: "hidden",
		width: "100%",
	},
	levelBarFill: {
		height: "100%",
		backgroundColor: "#111827",
	},
	levelPercent: {
		marginTop: 4,
		color: "#6b7280",
		fontSize: 12,
	},
	liveRow: {
		flexDirection: "row",
		alignItems: "center",
		marginHorizontal: 20,
		marginBottom: 8,
	},
	liveDot: {
		width: 10,
		height: 10,
		borderRadius: 5,
		marginRight: 8,
	},
	liveDotOn: {
		backgroundColor: "#22c55e",
	},
	liveDotOff: {
		backgroundColor: "#9ca3af",
	},
	liveTextOn: {
		color: "#16a34a",
		fontWeight: "500",
	},
	liveTextOff: {
		color: "#6b7280",
	},
});
