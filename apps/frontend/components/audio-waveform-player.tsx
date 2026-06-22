"use client";

import type { AudioMaskInterval } from "@outcomes/shared-types";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

const WAVEFORM_BUCKET_COUNT = 240;
const SVG_WIDTH = 640;
const PLOT_LEFT = 52;
const PLOT_RIGHT = 620;
const PLOT_TOP = 18;
const PLOT_BOTTOM = 124;
const MIN_INTERVAL_SECONDS = 0.05;
const PLAYBACK_SPEED_OPTIONS = [0.75, 0.8, 1, 1.25, 1.5, 2];
const WAVEFORM_ZOOM_LEVELS = [1, 1.25, 1.5, 2, 3, 4];

interface WaveformBucket {
  min: number;
  max: number;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.000";
  const totalMilliseconds = Math.round(seconds * 1000);
  const minutes = Math.floor(totalMilliseconds / 60000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function buildWaveformBuckets(buffer: AudioBuffer, bucketCount: number): WaveformBucket[] {
  const channels = Math.min(buffer.numberOfChannels, 2);
  if (channels === 0) return [];

  const blockSize = Math.max(1, Math.floor(buffer.length / bucketCount));
  const rawBuckets: WaveformBucket[] = [];

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = bucketIndex * blockSize;
    const end = Math.min(start + blockSize, buffer.length);
    let min = 0;
    let max = 0;

    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const channelData = buffer.getChannelData(channelIndex);
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const sample = channelData[sampleIndex] ?? 0;
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
    }

    rawBuckets.push({ min, max });
  }

  const maxAmplitude = Math.max(...rawBuckets.flatMap((bucket) => [Math.abs(bucket.min), Math.abs(bucket.max)]), 0.001);
  return rawBuckets.map((bucket) => ({
    min: bucket.min / maxAmplitude,
    max: bucket.max / maxAmplitude,
  }));
}

function buildEnvelopePath(buckets: WaveformBucket[]): string {
  if (buckets.length === 0) return "";

  const centerY = (PLOT_TOP + PLOT_BOTTOM) / 2;
  const scaleY = (PLOT_BOTTOM - PLOT_TOP) / 2;
  const xStep = buckets.length > 1 ? (PLOT_RIGHT - PLOT_LEFT) / (buckets.length - 1) : 0;

  const upper = buckets.map((bucket, index) => {
    const x = PLOT_LEFT + index * xStep;
    const y = centerY - Math.max(0, bucket.max) * scaleY;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  const lower = buckets
    .map((bucket, index) => {
      const x = PLOT_LEFT + index * xStep;
      const y = centerY - Math.min(0, bucket.min) * scaleY;
      return `L ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .reverse();

  return `${upper.join(" ")} ${lower.join(" ")} Z`;
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampTime(value: number, maxTime: number): number {
  return Math.min(Math.max(0, value), Math.max(0, maxTime));
}

function intervalLabel(interval: AudioMaskInterval): string {
  return interval.labels.join(", ") || "PII";
}

function intervalKey(interval: AudioMaskInterval, index: number): string {
  return `${interval.start_seconds}-${interval.end_seconds}-${interval.labels.join("|")}-${interval.text}-${index}`;
}

interface AudioWaveformPlayerProps {
  audioUrl: string | null;
  highlightIntervals?: AudioMaskInterval[];
  referenceIntervals?: AudioMaskInterval[];
  editableIntervals?: boolean;
  allowDownloadControls?: boolean;
  onIntervalsChange?: (intervals: AudioMaskInterval[]) => void;
}

export function AudioWaveformPlayer({
  audioUrl,
  highlightIntervals = [],
  referenceIntervals = [],
  editableIntervals = false,
  allowDownloadControls = false,
  onIntervalsChange,
}: AudioWaveformPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveformFrameRef = useRef<HTMLButtonElement | null>(null);
  const dragStateRef = useRef<{ index: number; edge: "start" | "end" } | null>(null);
  const [waveformBuckets, setWaveformBuckets] = useState<WaveformBucket[]>([]);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [zoomLevel, setZoomLevel] = useState(1);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, audioUrl]);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const audio = audioRef.current;
      if (!audio || !audioUrl) return;
      if (event.key === " " || event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (audio.paused) {
          void audio.play().catch(() => undefined);
        } else {
          audio.pause();
        }
      }
      if (event.key === "ArrowLeft" || event.key.toLowerCase() === "j") {
        event.preventDefault();
        audio.currentTime = Math.max(0, audio.currentTime - 5);
        setCurrentTime(audio.currentTime);
      }
      if (event.key === "ArrowRight" || event.key.toLowerCase() === "l") {
        event.preventDefault();
        audio.currentTime = Math.min(duration || audio.duration || Number.POSITIVE_INFINITY, audio.currentTime + 5);
        setCurrentTime(audio.currentTime);
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [audioUrl, duration]);

  useEffect(() => {
    setCurrentTime(0);
    if (!audioUrl) {
      setWaveformBuckets([]);
      setDuration(0);
      setWaveformLoading(false);
      setWaveformError("Audio not available.");
      return;
    }
    const resolvedAudioUrl: string = audioUrl;

    const AudioContextConstructor =
      typeof window !== "undefined"
        ? (window.AudioContext ??
          (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;

    if (!AudioContextConstructor) {
      setWaveformBuckets([]);
      setWaveformLoading(false);
      setWaveformError("Waveform preview is not supported in this browser.");
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function loadWaveform() {
      const LocalAudioContextConstructor = AudioContextConstructor;
      if (!LocalAudioContextConstructor) {
        setWaveformLoading(false);
        setWaveformError("Waveform preview is not supported in this browser.");
        return;
      }

      setWaveformLoading(true);
      setWaveformError(null);
      try {
        const response = await fetch(resolvedAudioUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Waveform fetch failed: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const context = new LocalAudioContextConstructor();

        try {
          const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
          if (cancelled) return;
          setDuration(decoded.duration || 0);
          setWaveformBuckets(buildWaveformBuckets(decoded, WAVEFORM_BUCKET_COUNT));
        } finally {
          void context.close().catch(() => undefined);
        }
      } catch (error) {
        if (cancelled) return;
        if ((error as { name?: string }).name === "AbortError") return;
        setWaveformBuckets([]);
        setWaveformError("Could not render waveform for this audio.");
      } finally {
        if (!cancelled) {
          setWaveformLoading(false);
        }
      }
    }

    void loadWaveform();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [audioUrl]);

  const progress = useMemo(
    () => (duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0),
    [currentTime, duration]
  );

  const waveformPath = useMemo(() => buildEnvelopePath(waveformBuckets), [waveformBuckets]);
  const displayDuration = useMemo(
    () => Math.max(duration, ...highlightIntervals.map((interval) => interval.end_seconds), ...referenceIntervals.map((interval) => interval.end_seconds), 0),
    [duration, highlightIntervals, referenceIntervals]
  );
  const playheadX = 52 + progress * (620 - 52);

  function notifyIntervalChange(index: number, edge: "start" | "end", value: number) {
    if (!onIntervalsChange || displayDuration <= 0) return;
    const next = highlightIntervals.map((interval, itemIndex) => {
      if (itemIndex !== index) return interval;
      const startLimit = edge === "start" ? interval.end_seconds - MIN_INTERVAL_SECONDS : displayDuration;
      const endLimit = edge === "end" ? interval.start_seconds + MIN_INTERVAL_SECONDS : 0;
      if (edge === "start") {
        return { ...interval, start_seconds: roundTime(Math.min(clampTime(value, displayDuration), startLimit)) };
      }
      return { ...interval, end_seconds: roundTime(Math.max(clampTime(value, displayDuration), endLimit)) };
    });
    onIntervalsChange(next);
  }

  function timeFromClientX(clientX: number): number {
    const rect = waveformFrameRef.current?.getBoundingClientRect();
    if (!rect || displayDuration <= 0) return 0;
    const svgX = ((clientX - rect.left) / rect.width) * SVG_WIDTH;
    const ratio = Math.min(1, Math.max(0, (svgX - PLOT_LEFT) / (PLOT_RIGHT - PLOT_LEFT)));
    return ratio * displayDuration;
  }

  function handleIntervalPointerDown(index: number, edge: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = { index, edge };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleIntervalKeyDown(index: number, edge: "start" | "end", event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const interval = highlightIntervals[index];
    if (!interval) return;
    const delta = event.key === "ArrowRight" ? 0.1 : -0.1;
    notifyIntervalChange(index, edge, (edge === "start" ? interval.start_seconds : interval.end_seconds) + delta);
  }

  function changeZoom(direction: 1 | -1) {
    setZoomLevel((currentZoom) => {
      const currentIndex = WAVEFORM_ZOOM_LEVELS.findIndex((level) => level === currentZoom);
      const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = Math.min(WAVEFORM_ZOOM_LEVELS.length - 1, Math.max(0, safeCurrentIndex + direction));
      return WAVEFORM_ZOOM_LEVELS[nextIndex];
    });
  }

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const dragState = dragStateRef.current;
      if (!dragState) return;
      notifyIntervalChange(dragState.index, dragState.edge, timeFromClientX(event.clientX));
    }

    function handlePointerUp() {
      dragStateRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  });

  return (
    <div className="rounded-xl border border-[#e5e7eb] bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_100%)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#6b7280]">
        <span className="font-medium text-[#374151]">Amplitude-Time Waveform</span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-1.5 font-medium text-[#4b5563]">
            <span>Playback speed</span>
            <select
              value={String(playbackRate)}
              onChange={(event) => setPlaybackRate(Number(event.target.value))}
              className="rounded-lg border border-[#ddd6fe] bg-white px-2 py-1 text-xs font-semibold text-[#241f43] shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8b5cf6]"
            >
              {PLAYBACK_SPEED_OPTIONS.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}x
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center overflow-hidden rounded-lg border border-[#ddd6fe] bg-white shadow-sm" aria-label="Waveform zoom controls">
            <button
              type="button"
              aria-label="Zoom out waveform"
              title="Zoom out waveform"
              onClick={() => changeZoom(-1)}
              disabled={zoomLevel === WAVEFORM_ZOOM_LEVELS[0]}
              className="px-2 py-1 font-semibold text-[#241f43] transition hover:bg-[#f5f3ff] disabled:cursor-not-allowed disabled:opacity-45"
            >
              -
            </button>
            <button
              type="button"
              aria-label="Reset waveform zoom"
              title="Reset waveform zoom"
              onClick={() => setZoomLevel(1)}
              className="border-x border-[#ede9fe] px-2 py-1 font-semibold text-[#241f43] transition hover:bg-[#f5f3ff]"
            >
              {Math.round(zoomLevel * 100)}%
            </button>
            <button
              type="button"
              aria-label="Zoom in waveform"
              title="Zoom in waveform"
              onClick={() => changeZoom(1)}
              disabled={zoomLevel === WAVEFORM_ZOOM_LEVELS[WAVEFORM_ZOOM_LEVELS.length - 1]}
              className="px-2 py-1 font-semibold text-[#241f43] transition hover:bg-[#f5f3ff] disabled:cursor-not-allowed disabled:opacity-45"
            >
              +
            </button>
          </div>
          <span className="min-w-[104px] text-right font-medium">
            {formatClock(currentTime)} / {formatClock(duration)}
          </span>
        </div>
      </div>

      <div className="relative mt-2 overflow-x-auto overflow-y-hidden rounded-lg border border-[#e5e7eb] bg-white">
        <button
          ref={waveformFrameRef}
          type="button"
          aria-label="Waveform seek area"
          className="block h-[168px] cursor-pointer border-0 bg-transparent p-0 text-left"
          style={{ width: `${zoomLevel * 100}%`, minWidth: "100%" }}
          onClick={(event) => {
            if (!audioRef.current || displayDuration <= 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            audioRef.current.currentTime = ratio * displayDuration;
            setCurrentTime(audioRef.current.currentTime);
          }}
        >
          <svg
            role="img"
            aria-label="Amplitude-time waveform"
            viewBox="0 0 640 160"
            preserveAspectRatio="none"
            className="h-full w-full"
          >
            <rect x="0" y="0" width="640" height="160" fill="#ffffff" />
            {referenceIntervals.map((interval, index) => {
              const startRatio = displayDuration > 0 ? interval.start_seconds / displayDuration : 0;
              const endRatio = displayDuration > 0 ? interval.end_seconds / displayDuration : 0;
              const x = PLOT_LEFT + Math.max(0, Math.min(1, startRatio)) * (PLOT_RIGHT - PLOT_LEFT);
              const width = Math.max(2, (Math.max(startRatio, endRatio) - Math.min(startRatio, endRatio)) * (PLOT_RIGHT - PLOT_LEFT));
              return (
                <g key={`reference-${intervalKey(interval, index)}`}>
                  <rect
                    x={x}
                    y={PLOT_TOP + 4}
                    width={width}
                    height={PLOT_BOTTOM - PLOT_TOP - 8}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                    opacity="0.85"
                  />
                  <text x={x + 4} y={PLOT_BOTTOM - 8} className="fill-[#1d4ed8] text-[9px] font-semibold">
                    Auto
                  </text>
                </g>
              );
            })}
            {highlightIntervals.map((interval, index) => {
              const startRatio = displayDuration > 0 ? interval.start_seconds / displayDuration : 0;
              const endRatio = displayDuration > 0 ? interval.end_seconds / displayDuration : 0;
              const x = PLOT_LEFT + Math.max(0, Math.min(1, startRatio)) * (PLOT_RIGHT - PLOT_LEFT);
              const width = Math.max(2, (Math.max(startRatio, endRatio) - Math.min(startRatio, endRatio)) * (PLOT_RIGHT - PLOT_LEFT));
              return (
                <g key={intervalKey(interval, index)}>
                  <rect
                    x={x}
                    y={PLOT_TOP}
                    width={width}
                    height={PLOT_BOTTOM - PLOT_TOP}
                    fill="#f97316"
                    opacity="0.18"
                  />
                  <line x1={x} y1={PLOT_TOP} x2={x} y2={PLOT_BOTTOM} stroke="#ea580c" strokeWidth="1.5" />
                  <line x1={x + width} y1={PLOT_TOP} x2={x + width} y2={PLOT_BOTTOM} stroke="#ea580c" strokeWidth="1.5" />
                  <text x={x + 4} y={PLOT_TOP + 12} className="fill-[#9a3412] text-[10px] font-semibold">
                    {intervalLabel(interval)}
                  </text>
                </g>
              );
            })}
            <line x1="52" y1="18" x2="52" y2="124" stroke="#cbd5e1" strokeWidth="1" />
            <line x1="52" y1="124" x2="620" y2="124" stroke="#cbd5e1" strokeWidth="1" />
            <line x1="52" y1="71" x2="620" y2="71" stroke="#e2e8f0" strokeWidth="1" strokeDasharray="4 4" />
            <text x="34" y="26" textAnchor="end" className="fill-[#64748b] text-[10px]">
              +1
            </text>
            <text x="34" y="74" textAnchor="end" className="fill-[#64748b] text-[10px]">
              0
            </text>
            <text x="34" y="124" textAnchor="end" className="fill-[#64748b] text-[10px]">
              -1
            </text>
            <text
              x="14"
              y="72"
              textAnchor="middle"
              transform="rotate(-90 14 72)"
              className="fill-[#475569] text-[11px] font-semibold"
            >
              Amplitude
            </text>
            <text x="336" y="150" textAnchor="middle" className="fill-[#475569] text-[11px] font-semibold">
              Time (s)
            </text>
            <text x="52" y="139" textAnchor="middle" className="fill-[#64748b] text-[10px]">
              0s
            </text>
            <text x="620" y="139" textAnchor="middle" className="fill-[#64748b] text-[10px]">
              {displayDuration > 0 ? `${displayDuration.toFixed(displayDuration >= 10 ? 0 : 1)}s` : "--"}
            </text>
            {waveformPath ? (
              <>
                <path d={waveformPath} fill="#7c6cb0" opacity="0.28" />
                <path d={waveformPath} fill="none" stroke="#4f46e5" strokeWidth="1.5" opacity="0.9" />
              </>
            ) : null}
            <line x1={playheadX} y1="18" x2={playheadX} y2="124" stroke="#0f172a" strokeWidth="2" opacity="0.35" />
          </svg>
          {waveformLoading || !waveformPath ? (
            <span className="pointer-events-none absolute inset-x-14 top-1/2 -translate-y-1/2 rounded-lg border border-[#e2e8f0] bg-white/90 px-3 py-2 text-center text-sm text-[#6b7280] shadow-sm">
              {waveformLoading ? "Loading amplitude waveform..." : waveformError ?? "Waveform unavailable."}
            </span>
          ) : null}
        </button>
        {editableIntervals && onIntervalsChange && displayDuration > 0
          ? highlightIntervals.map((interval, index) => {
              const startPercent =
                ((PLOT_LEFT + (interval.start_seconds / displayDuration) * (PLOT_RIGHT - PLOT_LEFT)) / SVG_WIDTH) * 100;
              const endPercent =
                ((PLOT_LEFT + (interval.end_seconds / displayDuration) * (PLOT_RIGHT - PLOT_LEFT)) / SVG_WIDTH) * 100;
              return (
                <div
                  key={`handles-${intervalKey(interval, index)}`}
                  className="pointer-events-none absolute left-0 top-0 h-[168px]"
                  style={{ width: `${zoomLevel * 100}%`, minWidth: "100%" }}
                >
                  <button
                    type="button"
                    aria-label={`PII start handle for ${intervalLabel(interval)} ${interval.text}`}
                    onPointerDown={(event) => handleIntervalPointerDown(index, "start", event)}
                    onKeyDown={(event) => handleIntervalKeyDown(index, "start", event)}
                    className="pointer-events-auto absolute top-[18px] h-[106px] w-3 -translate-x-1/2 cursor-ew-resize rounded-full border border-[#c2410c] bg-[#fff7ed] shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ea580c]"
                    style={{ left: `${startPercent}%` }}
                  />
                  <button
                    type="button"
                    aria-label={`PII end handle for ${intervalLabel(interval)} ${interval.text}`}
                    onPointerDown={(event) => handleIntervalPointerDown(index, "end", event)}
                    onKeyDown={(event) => handleIntervalKeyDown(index, "end", event)}
                    className="pointer-events-auto absolute top-[18px] h-[106px] w-3 -translate-x-1/2 cursor-ew-resize rounded-full border border-[#c2410c] bg-[#fff7ed] shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ea580c]"
                    style={{ left: `${endPercent}%` }}
                  />
                </div>
              );
            })
          : null}
      </div>

      {audioUrl ? (
        <audio
          ref={audioRef}
          controls
          controlsList={allowDownloadControls ? undefined : "nodownload"}
          preload="metadata"
          className="mt-3 w-full"
          onContextMenu={allowDownloadControls ? undefined : (event) => event.preventDefault()}
          onLoadedMetadata={(event) => {
            event.currentTarget.playbackRate = playbackRate;
            setDuration(event.currentTarget.duration || 0);
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
          onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
          onEnded={() => setCurrentTime(0)}
        >
          <source src={audioUrl} />
        </audio>
      ) : null}
    </div>
  );
}
